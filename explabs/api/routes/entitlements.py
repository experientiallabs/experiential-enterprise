# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Platform-operator management of per-org enterprise entitlements.

The hosted tier of the capability registry (explabs/api/capabilities.py): a
row in ``org_entitlements`` licenses ONE org for one enterprise capability,
which is how a paying enterprise account gets the /ee surfaces while every
other org on the deployment stays unlicensed. Grants may carry an expiry for
time-bound pilots. Platform admins only — this is a selling surface, not a
tenant surface — and every grant/revoke is an audit event.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.capabilities import EnterpriseCapability
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import RequestActor, get_request_actor, require_platform_admin
from explabs.db.repositories import DeleteCapableQuery, RepositoryError, SupabaseClient

router = APIRouter(prefix="/api", tags=["entitlements"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]


class EntitlementView(BaseModel):
    """One org's grant for one enterprise capability."""

    model_config = ConfigDict(frozen=True)

    capability: str
    granted_by: str | None
    note: str | None
    created_at: str | None
    expires_at: str | None


class OrgEntitlementsResponse(BaseModel):
    """Every entitlement row an org holds (expired rows included, marked)."""

    org_id: str
    entitlements: list[EntitlementView]


class EntitlementGrantRequest(BaseModel):
    """One grant: optionally time-bound, optionally annotated."""

    model_config = ConfigDict(extra="forbid")

    note: str | None = Field(default=None, max_length=512)
    expires_at: str | None = None


class EntitlementDeleteResponse(BaseModel):
    """Whether the revoke removed a grant."""

    model_config = ConfigDict(frozen=True)

    revoked: bool


def _capability(raw: str) -> EnterpriseCapability:
    """Parse a path capability or 404 (unknown keys must not be enumerable)."""
    try:
        return EnterpriseCapability(raw)
    except ValueError as error:
        msg = "Not found"
        raise ApiError(msg, status_code=404) from error


def _parsed_expiry(raw: str | None) -> str | None:
    """Validate an ISO expiry (must be in the future), or a typed 400."""
    if raw is None:
        return None
    try:
        stamp = datetime.fromisoformat(raw)
    except ValueError as error:
        msg = f"expires_at is not an ISO-8601 timestamp: {raw!r}"
        raise ApiError(msg, status_code=400) from error
    if stamp.tzinfo is None:
        msg = "expires_at must carry a timezone offset"
        raise ApiError(msg, status_code=400)
    if stamp <= datetime.now(tz=UTC):
        msg = "expires_at is already in the past"
        raise ApiError(msg, status_code=400)
    return stamp.isoformat()


@router.get("/admin/orgs/{org_id}/entitlements", response_model=OrgEntitlementsResponse)
def list_org_entitlements(org_id: str, client: Client, actor: Actor) -> OrgEntitlementsResponse:
    """List one org's entitlement grants (operator surface)."""
    require_platform_admin(actor)
    load_org_row(client, org_id)
    result = client.table("org_entitlements").select("*").eq("org_id", org_id).execute()
    rows = sorted(result.data, key=lambda row: str(row.get("capability", "")))
    return OrgEntitlementsResponse(
        org_id=org_id,
        entitlements=[
            EntitlementView(
                capability=str(row["capability"]),
                granted_by=(None if row.get("granted_by") is None else str(row["granted_by"])),
                note=(None if row.get("note") is None else str(row["note"])),
                created_at=(None if row.get("created_at") is None else str(row["created_at"])),
                expires_at=(None if row.get("expires_at") is None else str(row["expires_at"])),
            )
            for row in rows
        ],
    )


@router.put("/admin/orgs/{org_id}/entitlements/{capability}", response_model=EntitlementView)
def grant_org_entitlement(
    org_id: str,
    capability: str,
    body: EntitlementGrantRequest,
    client: Client,
    actor: Actor,
) -> EntitlementView:
    """Grant (or re-grant with new terms) one capability to one org."""
    require_platform_admin(actor)
    load_org_row(client, org_id)
    parsed = _capability(capability)
    expires_at = _parsed_expiry(body.expires_at)
    row = {
        "org_id": org_id,
        "capability": parsed.value,
        "granted_by": actor.user_id,
        "note": body.note,
        "created_at": datetime.now(tz=UTC).isoformat(),
        "expires_at": expires_at,
    }
    client.table("org_entitlements").upsert(dict(row), on_conflict="org_id, capability").execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ENTITLEMENTS_GRANT,
        object_type="entitlement",
        object_id=parsed.value,
        after={"capability": parsed.value, "expires_at": expires_at, "note": body.note},
    )
    return EntitlementView(
        capability=parsed.value,
        granted_by=actor.user_id,
        note=body.note,
        created_at=str(row["created_at"]),
        expires_at=expires_at,
    )


@router.delete(
    "/admin/orgs/{org_id}/entitlements/{capability}",
    response_model=EntitlementDeleteResponse,
)
def revoke_org_entitlement(
    org_id: str,
    capability: str,
    client: Client,
    actor: Actor,
) -> EntitlementDeleteResponse:
    """Revoke one capability grant; the org's surface goes absent immediately."""
    require_platform_admin(actor)
    load_org_row(client, org_id)
    parsed = _capability(capability)
    query = client.table("org_entitlements")
    if not isinstance(query, DeleteCapableQuery):  # pragma: no cover - real clients delete
        msg = "Supabase query builder does not support delete"
        raise RepositoryError(msg)
    deleted = query.delete().eq("org_id", org_id).eq("capability", parsed.value).execute().data
    if not deleted:
        msg = "Not found"
        raise ApiError(msg, status_code=404)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ENTITLEMENTS_REVOKE,
        object_type="entitlement",
        object_id=parsed.value,
    )
    return EntitlementDeleteResponse(revoked=True)
