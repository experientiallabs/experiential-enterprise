# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Provider data-control management (design E5 item 3).

Two surfaces over the data-control tables:

* ``/api/orgs/{org_id}/provider-data-controls`` — the platform-curated
  provider posture matrix (``provider_data_controls``): per-provider
  zero-data-retention / no-training flags describing each provider's
  DOCUMENTED DEFAULT API posture, never customer-specific agreements, each
  with the source note it is based on. Member-strength and deliberately NOT
  capability-gated: it is curated metadata the catalog UI may show any org.
* ``/api/orgs/{org_id}/provider-policy`` — the org's data-control policy
  (``org_provider_policies``): a provider allowlist plus require-ZDR /
  require-no-training toggles. Reads are member-strength; mutations are
  admin-strength; every call is gated on the DATA_CONTROLS /ee capability
  (default-off: an unlicensed org 404s exactly like the surface does not
  exist) and every mutation emits one audit event.

The capability gates MANAGEMENT only. Enforcement of an existing policy is
ALWAYS-ON in the gateway worker (route filtering + execution-snapshot
rebuild) and never license-dependent — a policy written while licensed keeps
enforcing after the license lapses. Policy writes reach the worker through
its catalog watermark (max ``updated_at`` + row counts over both tables), so
the upsert always moves ``updated_at`` and the delete changes the row count.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.capabilities import EnterpriseCapability, require_capability
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    RepositoryError,
    SupabaseClient,
    SupabaseQueryBuilder,
    find_one_by_columns,
    result_rows,
)

router = APIRouter(prefix="/api", tags=["data-controls"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

_EMPTY_ALLOWLIST_MSG = (
    "allowed_providers must name at least one provider; send null to allow all providers."
)
_NO_POLICY_MSG = "No provider policy is set for this organization."


class ProviderPolicyBody(BaseModel):
    """The full policy document a PUT replaces the org's policy with."""

    # null = all providers allowed; an empty list is refused (it would refuse
    # every request, which is a policy no one means to write).
    allowed_providers: list[str] | None = None
    require_zdr: bool
    require_no_training: bool


class ProviderDataControlsView(BaseModel):
    """One provider's curated default data-handling posture."""

    model_config = ConfigDict(frozen=True)

    provider: str
    zero_data_retention: bool
    no_training: bool
    # The provider policy the flags are based on; the UI renders it verbatim
    # so the claim stays auditable.
    source_note: str
    updated_at: str


class ProviderDataControlsResponse(BaseModel):
    """The full posture matrix, alphabetical by provider."""

    providers: list[ProviderDataControlsView]


class ProviderPolicyView(BaseModel):
    """One org's data-control policy as the settings panel reads it."""

    model_config = ConfigDict(frozen=True)

    org_id: str
    allowed_providers: list[str] | None
    require_zdr: bool
    require_no_training: bool
    created_by: str | None
    updated_by: str | None
    created_at: str
    updated_at: str


class ProviderPolicyResponse(BaseModel):
    """The org's policy, or the typed no-policy shape (``policy: null``)."""

    org_id: str
    policy: ProviderPolicyView | None


def _delete_query(client: SupabaseClient, table: str) -> SupabaseQueryBuilder:
    """Start a delete on one table, probing the narrow delete capability."""
    query = client.table(table)
    if not isinstance(query, DeleteCapableQuery):
        msg = "Supabase query builder does not support delete"
        raise RepositoryError(msg)
    return query.delete()


def _org_not_found(org_id: str) -> str:
    return f"Organization not found: {org_id}"


def _now() -> str:
    """Timestamp for writes; explicit so the row is complete at insert time."""
    return datetime.now(tz=UTC).isoformat()


def _require_policy_surface(
    client: SupabaseClient,
    actor: RequestActor,
    org_id: str,
    minimum: OrgRole,
) -> None:
    """Gate one policy handler: org exists, role suffices, DATA_CONTROLS licensed.

    Role before capability (the audit_log.py convention): membership and role
    semantics are unchanged — outsiders get the org 404, under-role members
    get 403 — and only licensing produces the extra "Not found" 404. The gate
    covers management only; worker enforcement of an existing policy is
    always-on and never consults licensing.
    """
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, minimum, not_found=_org_not_found(org_id))
    require_capability(client, org_id, EnterpriseCapability.DATA_CONTROLS)


def _matrix_rows(client: SupabaseClient) -> tuple[JsonObject, ...]:
    """The full posture matrix, alphabetical by provider."""
    return tuple(
        result_rows(client.table("provider_data_controls").select("*").order("provider").execute())
    )


def _row_allowlist(row: JsonObject) -> list[str] | None:
    """The row's allowlist as a typed list, or ``None`` for "all providers"."""
    allowed = row.get("allowed_providers")
    if allowed is None:
        return None
    if not isinstance(allowed, list):
        msg = "org_provider_policies.allowed_providers must be a list or null"
        raise RepositoryError(msg)
    return [str(provider) for provider in allowed]


def _policy_view(row: JsonObject) -> ProviderPolicyView:
    """Project one ``org_provider_policies`` row onto the wire shape."""
    created_by = row.get("created_by")
    updated_by = row.get("updated_by")
    return ProviderPolicyView(
        org_id=str(row["org_id"]),
        allowed_providers=_row_allowlist(row),
        require_zdr=bool(row["require_zdr"]),
        require_no_training=bool(row["require_no_training"]),
        created_by=str(created_by) if created_by is not None else None,
        updated_by=str(updated_by) if updated_by is not None else None,
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _policy_snapshot(row: JsonObject) -> JsonObject:
    """The audit before/after payload: only the fields a PUT can change."""
    return {
        "allowed_providers": _row_allowlist(row),
        "require_zdr": bool(row["require_zdr"]),
        "require_no_training": bool(row["require_no_training"]),
    }


def _validated_allowlist(client: SupabaseClient, body: ProviderPolicyBody) -> list[str] | None:
    """Canonicalize the allowlist: deduplicated, sorted, every token known.

    Args:
        client: Service-role Supabase client.
        body: The incoming policy document.

    Returns:
        The sorted unique provider tokens, or ``None`` for "all providers".

    Raises:
        ApiError: 422 for an empty list; 400 naming any provider absent from
            ``provider_data_controls`` (a provider outside the matrix fails
            every data-control requirement, so allowing it is a mistake the
            boundary should catch).
    """
    if body.allowed_providers is None:
        return None
    allowed = sorted(set(body.allowed_providers))
    if not allowed:
        raise ApiError(_EMPTY_ALLOWLIST_MSG, status_code=422)
    known = {str(row["provider"]) for row in _matrix_rows(client)}
    unknown = [provider for provider in allowed if provider not in known]
    if unknown:
        msg = f"Unknown providers: {', '.join(unknown)}"
        raise ApiError(msg, status_code=400)
    return allowed


@router.get("/orgs/{org_id}/provider-data-controls")
def get_provider_data_controls(
    org_id: str,
    client: Client,
    actor: Actor,
) -> ProviderDataControlsResponse:
    """The curated provider posture matrix (member-strength, not /ee-gated)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.USER, not_found=_org_not_found(org_id))
    return ProviderDataControlsResponse(
        providers=[
            ProviderDataControlsView(
                provider=str(row["provider"]),
                zero_data_retention=bool(row["zero_data_retention"]),
                no_training=bool(row["no_training"]),
                source_note=str(row["source_note"]),
                updated_at=str(row["updated_at"]),
            )
            for row in _matrix_rows(client)
        ]
    )


@router.get("/orgs/{org_id}/provider-policy")
def get_provider_policy(org_id: str, client: Client, actor: Actor) -> ProviderPolicyResponse:
    """The org's data-control policy; ``policy: null`` when none is set."""
    _require_policy_surface(client, actor, org_id, OrgRole.USER)
    row = find_one_by_columns(client, "org_provider_policies", {"org_id": org_id})
    return ProviderPolicyResponse(
        org_id=org_id, policy=_policy_view(row) if row is not None else None
    )


@router.put("/orgs/{org_id}/provider-policy")
def put_provider_policy(
    org_id: str,
    body: ProviderPolicyBody,
    client: Client,
    actor: Actor,
) -> ProviderPolicyResponse:
    """Replace the org's data-control policy (admins only).

    Full-document semantics: the row becomes exactly the request body. The
    write moves ``updated_at``, which the gateway worker's catalog watermark
    observes — enforcement picks the new policy up without a restart.
    """
    _require_policy_surface(client, actor, org_id, OrgRole.ADMIN)
    allowed = _validated_allowlist(client, body)
    existing = find_one_by_columns(client, "org_provider_policies", {"org_id": org_id})
    now = _now()
    if existing is None:
        row: JsonObject = {
            "org_id": org_id,
            "allowed_providers": allowed,
            "require_zdr": body.require_zdr,
            "require_no_training": body.require_no_training,
            "created_by": actor.user_id,
            "updated_by": actor.user_id,
            "created_at": now,
            "updated_at": now,
        }
        client.table("org_provider_policies").insert(dict(row)).execute()
    else:
        changes: JsonObject = {
            "allowed_providers": allowed,
            "require_zdr": body.require_zdr,
            "require_no_training": body.require_no_training,
            "updated_by": actor.user_id,
            "updated_at": now,
        }
        client.table("org_provider_policies").update(dict(changes)).eq("org_id", org_id).execute()
        row = dict(existing) | changes
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.PROVIDER_POLICY_SET,
        object_type="provider_policy",
        object_id=org_id,
        before=_policy_snapshot(existing) if existing is not None else None,
        after=_policy_snapshot(row),
    )
    return ProviderPolicyResponse(org_id=org_id, policy=_policy_view(row))


@router.delete("/orgs/{org_id}/provider-policy")
def delete_provider_policy(org_id: str, client: Client, actor: Actor) -> dict[str, bool]:
    """Remove the org's data-control policy (admins only).

    The row disappearing changes the watermark's row count, so the gateway
    worker stops enforcing on its next catalog refresh.
    """
    _require_policy_surface(client, actor, org_id, OrgRole.ADMIN)
    existing = find_one_by_columns(client, "org_provider_policies", {"org_id": org_id})
    if existing is None:
        raise ApiError(_NO_POLICY_MSG, status_code=404)
    _delete_query(client, "org_provider_policies").eq("org_id", org_id).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.PROVIDER_POLICY_DELETE,
        object_type="provider_policy",
        object_id=org_id,
        before=_policy_snapshot(existing),
    )
    return {"deleted": True}
