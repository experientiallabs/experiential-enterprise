# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Named / abstract alias management API (identity tier P-E).

A named alias is an admin-defined model name (e.g. ``coding``) whose target is
a platform model an admin can repoint over time without customers changing the
name they call. Mounted on the control/all API role beside the models catalog
routes (``models_catalog.py``); every route is a mutation or an admin read, so
customer ``xpl_`` keys never reach it (the ``_CUSTOMER_KEY_ROUTES`` allowlist in
``app.py`` is unchanged) and org-admin membership is required.

The alias mechanism itself ships in int-p1: an alias is a ``gateway_aliases``
row with immutable, repointable revisions. These routes add the admin write
path over those functions:

* **Create** (``POST /api/aliases``) synthesizes an ``origin='named'`` alias and
  its first revision, pointing it at a chosen model by copying that model's
  current catalog alias revision (the same snapshot + single-model pool the
  catalog builder already registered for it).
* **Repoint** (``PUT /api/aliases/{name}``) activates a new revision copied from
  a different model's catalog revision; the old revision stays immutable.
* **History / rollback** (``GET /api/aliases/{name}/revisions`` +
  ``POST /api/aliases/{name}/rollback``) list the repoint history and
  re-activate a prior revision (idempotent, content-checked by int-p1).
* **Retire** (``DELETE /api/aliases/{name}``) deactivates the alias, reversibly.

A named alias freezes to its target model's catalog snapshot at repoint time
(revisions are immutable by design); repoint again to pick up later catalog
changes to that model.
"""

from __future__ import annotations

import re
import uuid
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Query, Response
from postgrest.exceptions import APIError as PostgrestAPIError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import JsonObject, SupabaseClient

router = APIRouter(prefix="/api", tags=["aliases"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# The name a customer puts in the `model` field must be a WMO ArtifactId for the
# control store to resolve it (control_store.py _ARTIFACT_ID_PATTERN); validate
# it here so an unroutable name is a self-correcting 422, not a silent alias.
_ALIAS_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_MODEL_SLUG_PATTERN = r"^[a-z][a-z0-9._-]{0,127}$"

_UNIQUE_VIOLATION = "23505"
_CHECK_VIOLATION = "23514"
_FK_VIOLATION = "23503"
_NO_DATA_FOUND = "P0002"


# ---------------------------------------------------------------------------
# Request bodies


class NamedAliasCreate(BaseModel):
    """Create a named alias pointing at a model in the acting organization."""

    model_config = ConfigDict(extra="forbid")

    # Required for session actors; a platform admin names the org explicitly.
    org_id: str | None = None
    name: str = Field(min_length=1, max_length=128)
    model: str = Field(pattern=_MODEL_SLUG_PATTERN)

    @field_validator("name")
    @classmethod
    def _valid_alias_name(cls, value: str) -> str:
        """Reject names the gateway could never resolve."""
        if _ALIAS_NAME_PATTERN.fullmatch(value) is None:
            msg = (
                "name must be a lowercase model alias (letter-first, words joined "
                "by '.', '_' or '-'), e.g. 'coding' or 'fast-chat'"
            )
            raise ValueError(msg)
        return value


class NamedAliasRepoint(BaseModel):
    """Repoint a named alias at a different model (a new revision)."""

    model_config = ConfigDict(extra="forbid")

    org_id: str | None = None
    model: str = Field(pattern=_MODEL_SLUG_PATTERN)


class NamedAliasRollback(BaseModel):
    """Roll a named alias back to one of its prior revisions."""

    model_config = ConfigDict(extra="forbid")

    org_id: str | None = None
    revision_id: str = Field(min_length=1, max_length=128)


# ---------------------------------------------------------------------------
# Views


class NamedAliasView(BaseModel):
    """One named alias with the model its current revision points at."""

    model_config = ConfigDict(frozen=True)

    alias_id: str
    name: str
    org_id: str
    active: bool
    current_revision_id: str | None
    target_model_slug: str | None
    target_model_id: str | None


class NamedAliasListView(BaseModel):
    """Response envelope for the named-alias listing."""

    aliases: tuple[NamedAliasView, ...]


class AliasRevisionView(BaseModel):
    """One revision in a named alias's repoint history."""

    model_config = ConfigDict(frozen=True)

    revision_id: str
    model_slug: str | None
    model_id: str | None
    is_current: bool
    created_at: str


class AliasRevisionListView(BaseModel):
    """Response envelope for a named alias's revision history."""

    name: str
    alias_id: str
    revisions: tuple[AliasRevisionView, ...]


# ---------------------------------------------------------------------------
# Tenancy + resolution helpers


def _resolve_alias_org(client: SupabaseClient, actor: Actor, org_id: str | None) -> str:
    """Resolve and authorize the organization a named alias belongs to.

    Named aliases are always org-scoped, so unlike the public catalog there is
    no ``org_id: null`` lane: a platform admin must still name one org.

    Raises:
        ApiError: 422 when no org is named, 404/403 per membership.
    """
    if org_id is None:
        msg = (
            "org_id is required: named aliases belong to one organization "
            "(GET /api/orgs lists your organizations)"
        )
        raise ApiError(msg, status_code=422)
    load_org_row(client, org_id)
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.ADMIN,
        not_found=f"Organization not found: {org_id}",
    )
    return org_id


def _resolve_backing_model(client: SupabaseClient, slug: str, org_id: str) -> JsonObject:
    """Resolve a model slug the acting org may point an alias at.

    The org's own model shadows a public row of the same slug; only rows the
    org can see (its own or public) are candidates.

    Raises:
        ApiError: 404 when no visible model matches.
    """
    result = (
        client.table("models").select("id, slug, owning_org_id, status").eq("slug", slug).execute()
    )
    visible = [
        dict(row)
        for row in result.data
        if row.get("owning_org_id") is None or str(row["owning_org_id"]) == org_id
    ]
    for row in visible:
        if row.get("owning_org_id") is not None:
            return row
    for row in visible:
        if row.get("owning_org_id") is None:
            return row
    msg = (
        f"model '{slug}' not found in the public catalog or your organization; "
        f"GET /api/models lists the models you can point an alias at"
    )
    raise ApiError(msg, status_code=404)


class _CatalogRevision(BaseModel):
    """The catalog alias revision a named alias copies from its target model."""

    model_config = ConfigDict(frozen=True)

    target: JsonObject
    catalog_sha256: str
    provider_connection_revisions: JsonObject
    certification: JsonObject | None
    refusal_failover: bool


def _model_catalog_revision(client: SupabaseClient, model_id: str, slug: str) -> _CatalogRevision:
    """Read a model's current catalog alias revision.

    The catalog builder registers one alias per model (``model-{id}``) with a
    snapshot and single-model pool; a named alias reuses exactly that binding,
    so the snapshot the revision references already exists.

    Raises:
        ApiError: 409 when the model has no active, routable catalog alias yet.
    """
    alias_rows = (
        client.table("gateway_aliases")
        .select("current_revision_id, active")
        .eq("alias_id", f"model-{model_id}")
        .execute()
    )
    if not alias_rows.data:
        raise _not_routable(slug)
    alias = dict(alias_rows.data[0])
    revision_id = alias.get("current_revision_id")
    if not bool(alias.get("active")) or revision_id is None:
        raise _not_routable(slug)
    revision_rows = (
        client.table("gateway_alias_revisions")
        .select(
            "target, catalog_sha256, provider_connection_revisions, certification, refusal_failover"
        )
        .eq("revision_id", str(revision_id))
        .execute()
    )
    if not revision_rows.data:
        raise _not_routable(slug)
    row = dict(revision_rows.data[0])
    return _CatalogRevision(
        target=cast("JsonObject", row["target"]),
        catalog_sha256=str(row["catalog_sha256"]),
        provider_connection_revisions=cast("JsonObject", row["provider_connection_revisions"]),
        certification=cast("JsonObject | None", row.get("certification")),
        refusal_failover=bool(row["refusal_failover"]),
    )


def _not_routable(slug: str) -> ApiError:
    """The 409 for a model the gateway catalog cannot yet route to."""
    msg = (
        f"model '{slug}' has no routable deployment in the gateway catalog yet; "
        f"add a working provider to it, then retry once the catalog refreshes"
    )
    return ApiError(msg, status_code=409)


def _resolve_named_alias(client: SupabaseClient, name: str, org_id: str) -> JsonObject:
    """Resolve one org-scoped named alias by name.

    Raises:
        ApiError: 404 when the org has no named alias with this name.
    """
    rows = (
        client.table("gateway_aliases")
        .select("alias_id, alias_name, org_id, active, current_revision_id")
        .eq("alias_name", name)
        .eq("org_id", org_id)
        .eq("origin", "named")
        .execute()
    )
    if not rows.data:
        msg = f"named alias '{name}' not found in this organization"
        raise ApiError(msg, status_code=404)
    return dict(rows.data[0])


def _targets_by_revision(client: SupabaseClient, revision_ids: list[str]) -> dict[str, JsonObject]:
    """Map each revision id to its recorded backing model, if any."""
    if not revision_ids:
        return {}
    rows = (
        client.table("gateway_named_alias_targets")
        .select("revision_id, model_id, model_slug")
        .in_("revision_id", revision_ids)
        .execute()
    )
    return {str(row["revision_id"]): dict(row) for row in rows.data}


def _alias_view(alias: JsonObject, target: JsonObject | None) -> NamedAliasView:
    """Project one named alias row plus its current target into a view."""
    return NamedAliasView(
        alias_id=str(alias["alias_id"]),
        name=str(alias["alias_name"]),
        org_id=str(alias["org_id"]),
        active=bool(alias["active"]),
        current_revision_id=(
            None if alias.get("current_revision_id") is None else str(alias["current_revision_id"])
        ),
        target_model_slug=None if target is None else cast("str | None", target.get("model_slug")),
        target_model_id=(
            None if target is None or target.get("model_id") is None else str(target["model_id"])
        ),
    )


def _translated_rpc_error(error: PostgrestAPIError, *, action: str) -> ApiError:
    """Map a gateway RPC rejection to a self-correcting client error."""
    detail = error.message or "database rejected the write"
    if error.code == _UNIQUE_VIOLATION:
        return ApiError(f"{action} conflicts with an existing alias: {detail}", status_code=409)
    if error.code == _CHECK_VIOLATION:
        return ApiError(f"{action} rejected: {detail}", status_code=422)
    if error.code == _FK_VIOLATION:
        return ApiError(f"{action} references a row that does not exist: {detail}", status_code=422)
    if error.code == _NO_DATA_FOUND:
        return ApiError(detail, status_code=404)
    raise error


def _activate(
    client: SupabaseClient,
    *,
    alias_id: str,
    name: str,
    org_id: str,
    revision_id: str,
    revision: _CatalogRevision,
    model_id: str | None,
    model_slug: str,
    action: str,
    actor_user_id: str,
) -> None:
    """Activate one named-alias revision through the sanctioned RPC."""
    try:
        client.rpc(
            "gateway_activate_named_alias_revision",
            {
                "p_alias_id": alias_id,
                "p_alias_name": name,
                "p_org_id": org_id,
                "p_revision_id": revision_id,
                "p_target": revision.target,
                "p_catalog_sha256": revision.catalog_sha256,
                "p_provider_connection_revisions": revision.provider_connection_revisions,
                "p_certification": revision.certification,
                "p_refusal_failover": revision.refusal_failover,
                "p_model_id": model_id,
                "p_model_slug": model_slug,
                "p_actor": actor_user_id,
            },
        ).execute()
    except PostgrestAPIError as error:
        raise _translated_rpc_error(error, action=action) from error


def _current_alias_view(client: SupabaseClient, name: str, org_id: str) -> NamedAliasView:
    """Re-read a named alias and project it with its current target."""
    alias = _resolve_named_alias(client, name, org_id)
    current = alias.get("current_revision_id")
    targets = _targets_by_revision(client, [] if current is None else [str(current)])
    return _alias_view(alias, None if current is None else targets.get(str(current)))


# ---------------------------------------------------------------------------
# Routes


@router.get("/aliases", response_model=NamedAliasListView)
def list_aliases(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    *,
    org_id: Annotated[str | None, Query()] = None,
) -> NamedAliasListView:
    """List an organization's named aliases with their current target model."""
    resolved_org = _resolve_alias_org(client, actor, org_id)
    rows = (
        client.table("gateway_aliases")
        .select("alias_id, alias_name, org_id, active, current_revision_id")
        .eq("org_id", resolved_org)
        .eq("origin", "named")
        .order("alias_name")
        .execute()
    )
    aliases = [dict(row) for row in rows.data]
    current_ids = [
        str(alias["current_revision_id"])
        for alias in aliases
        if alias.get("current_revision_id") is not None
    ]
    targets = _targets_by_revision(client, current_ids)
    return NamedAliasListView(
        aliases=tuple(
            _alias_view(
                alias,
                None
                if alias.get("current_revision_id") is None
                else targets.get(str(alias["current_revision_id"])),
            )
            for alias in aliases
        )
    )


@router.post("/aliases", response_model=NamedAliasView, status_code=201)
def create_alias(
    body: NamedAliasCreate,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> NamedAliasView:
    """Create a named alias pointing at a model's current catalog revision."""
    org_id = _resolve_alias_org(client, actor, body.org_id)
    model = _resolve_backing_model(client, body.model, org_id)
    model_id = str(model["id"])
    revision = _model_catalog_revision(client, model_id, body.model)
    alias_id = f"named-{uuid.uuid4().hex}"
    revision_id = f"nrev-{uuid.uuid4().hex}"
    _activate(
        client,
        alias_id=alias_id,
        name=body.name,
        org_id=org_id,
        revision_id=revision_id,
        revision=revision,
        model_id=model_id,
        model_slug=str(model["slug"]),
        action=f"creating named alias '{body.name}'",
        actor_user_id=actor.user_id,
    )
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ALIASES_CREATE,
        object_type="alias",
        object_id=alias_id,
        after={"name": body.name, "model": body.model, "revision_id": revision_id},
    )
    return _current_alias_view(client, body.name, org_id)


@router.put("/aliases/{name}", response_model=NamedAliasView)
def repoint_alias(
    name: str,
    body: NamedAliasRepoint,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> NamedAliasView:
    """Repoint a named alias at a different model as a new revision."""
    org_id = _resolve_alias_org(client, actor, body.org_id)
    alias = _resolve_named_alias(client, name, org_id)
    model = _resolve_backing_model(client, body.model, org_id)
    model_id = str(model["id"])
    revision = _model_catalog_revision(client, model_id, body.model)
    revision_id = f"nrev-{uuid.uuid4().hex}"
    _activate(
        client,
        alias_id=str(alias["alias_id"]),
        name=name,
        org_id=org_id,
        revision_id=revision_id,
        revision=revision,
        model_id=model_id,
        model_slug=str(model["slug"]),
        action=f"repointing named alias '{name}'",
        actor_user_id=actor.user_id,
    )
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ALIASES_REPOINT,
        object_type="alias",
        object_id=str(alias["alias_id"]),
        after={"name": name, "model": body.model, "revision_id": revision_id},
    )
    return _current_alias_view(client, name, org_id)


@router.get("/aliases/{name}/revisions", response_model=AliasRevisionListView)
def list_alias_revisions(
    name: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    *,
    org_id: Annotated[str | None, Query()] = None,
) -> AliasRevisionListView:
    """List a named alias's repoint history, newest first."""
    resolved_org = _resolve_alias_org(client, actor, org_id)
    alias = _resolve_named_alias(client, name, resolved_org)
    alias_id = str(alias["alias_id"])
    current_revision_id = alias.get("current_revision_id")
    revisions = (
        client.table("gateway_alias_revisions")
        .select("revision_id, created_at")
        .eq("alias_id", alias_id)
        .order("created_at", desc=True)
        .execute()
    )
    rows = [dict(row) for row in revisions.data]
    targets = _targets_by_revision(client, [str(row["revision_id"]) for row in rows])
    return AliasRevisionListView(
        name=name,
        alias_id=alias_id,
        revisions=tuple(
            AliasRevisionView(
                revision_id=str(row["revision_id"]),
                model_slug=(
                    None
                    if str(row["revision_id"]) not in targets
                    else cast("str | None", targets[str(row["revision_id"])].get("model_slug"))
                ),
                model_id=(
                    None
                    if str(row["revision_id"]) not in targets
                    or targets[str(row["revision_id"])].get("model_id") is None
                    else str(targets[str(row["revision_id"])]["model_id"])
                ),
                is_current=(
                    current_revision_id is not None
                    and str(row["revision_id"]) == str(current_revision_id)
                ),
                created_at=str(row["created_at"]),
            )
            for row in rows
        ),
    )


@router.post("/aliases/{name}/rollback", response_model=NamedAliasView)
def rollback_alias(
    name: str,
    body: NamedAliasRollback,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> NamedAliasView:
    """Roll a named alias back to one of its prior revisions."""
    org_id = _resolve_alias_org(client, actor, body.org_id)
    alias = _resolve_named_alias(client, name, org_id)
    alias_id = str(alias["alias_id"])
    revision_rows = (
        client.table("gateway_alias_revisions")
        .select(
            "target, catalog_sha256, provider_connection_revisions, certification, refusal_failover"
        )
        .eq("revision_id", body.revision_id)
        .eq("alias_id", alias_id)
        .execute()
    )
    if not revision_rows.data:
        msg = f"revision '{body.revision_id}' does not belong to named alias '{name}'"
        raise ApiError(msg, status_code=404)
    row = dict(revision_rows.data[0])
    revision = _CatalogRevision(
        target=cast("JsonObject", row["target"]),
        catalog_sha256=str(row["catalog_sha256"]),
        provider_connection_revisions=cast("JsonObject", row["provider_connection_revisions"]),
        certification=cast("JsonObject | None", row.get("certification")),
        refusal_failover=bool(row["refusal_failover"]),
    )
    target = _targets_by_revision(client, [body.revision_id]).get(body.revision_id, {})
    recorded_model_id = target.get("model_id")
    _activate(
        client,
        alias_id=alias_id,
        name=name,
        org_id=org_id,
        revision_id=body.revision_id,
        revision=revision,
        model_id=None if recorded_model_id is None else str(recorded_model_id),
        model_slug=str(target.get("model_slug", "")),
        action=f"rolling back named alias '{name}'",
        actor_user_id=actor.user_id,
    )
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ALIASES_ROLLBACK,
        object_type="alias",
        object_id=alias_id,
        after={"name": name, "revision_id": body.revision_id},
    )
    return _current_alias_view(client, name, org_id)


@router.delete("/aliases/{name}", status_code=204)
def deactivate_alias(
    name: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    response: Response,
    *,
    org_id: Annotated[str | None, Query()] = None,
) -> Response:
    """Retire a named alias (reversible: rollback re-activates it)."""
    resolved_org = _resolve_alias_org(client, actor, org_id)
    alias = _resolve_named_alias(client, name, resolved_org)
    try:
        client.rpc(
            "gateway_deactivate_alias",
            {"p_alias_id": str(alias["alias_id"]), "p_actor": actor.user_id},
        ).execute()
    except PostgrestAPIError as error:
        raise _translated_rpc_error(error, action=f"retiring named alias '{name}'") from error
    record_audit_event(
        client,
        actor=actor,
        org_id=resolved_org,
        action=AuditAction.ALIASES_RETIRE,
        object_type="alias",
        object_id=str(alias["alias_id"]),
        after={"name": name, "active": False},
    )
    response.status_code = 204
    return response
