# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Identity-tier management routes: identities, grants, and budgets.

The dashboard control plane over the P-A/P-B/P-C tables. Every route is
deployment-key + org-admin gated (reads admit any member; mutations demand an
admin), exactly like the sibling gateway management routes. These paths are NOT
in app.py's ``_CUSTOMER_KEY_ROUTES`` allowlist, so a customer ``xpl_`` key never
reaches them -- identity/grant/budget mutations stay dashboard-only.

Per-identity KEYS are issued through the existing web-app mint route
(apps/web/app/api/keys), which now writes ``api_keys.identity_id``; this module
owns identities, the grant matrix, and budgets.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import SupabaseClient, find_one_by_columns
from explabs.db.stores.gateway_identity_store import (
    BUDGET_SCOPE_KINDS,
    RECURRING_PERIOD,
    AliasSummary,
    BudgetBalance,
    GatewayIdentityStore,
    IdentityRecord,
    IdentitySummary,
    default_identity_id,
    is_valid_identity_id,
    slugify_identity_id,
)

router = APIRouter(prefix="/api", tags=["identities"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

_PERIOD_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

# The org's own default identity id prefix is reserved: callers may not mint an
# id that could collide with any org's synthetic default.
_RESERVED_ID_PREFIX = "org-"

# Static failure messages (assigned to names so the raise sites carry no string
# literal, per the repo's exception-message lint).
_RESERVED_PREFIX_MSG = "Identity ids beginning with 'org-' are reserved for the default identity."
_INVALID_ID_MSG = "Identity id must be lowercase alphanumerics separated by '.', '-', or '_'."
_DEFAULT_PROTECTED_MSG = (
    "The default identity holds the organization's own keys and cannot be disabled."
)
_NO_FIELDS_MSG = "No identity fields to update."
_IDENTITY_SCOPE_MSG = "An identity budget requires identity_id."
_KEY_SCOPE_MSG = "A key budget requires api_key_id."
_MODEL_SCOPE_MSG = "A model budget requires alias_id."
_POOL_SCOPE_MSG = "A pool budget requires alias_id and pool_id."
_DEPLOYMENT_SCOPE_MSG = "A deployment budget requires alias_id, pool_id, and deployment_id."
_PERIOD_MSG = "period must be a 'YYYY-MM' month, e.g. 2026-08."
_BUDGET_PERIOD_MSG = "period must be a 'YYYY-MM' month (e.g. 2026-08) or '*' for recurring."


# -- Request bodies ---------------------------------------------------------


class CreateIdentityBody(BaseModel):
    """Create one named identity under the org."""

    display_name: str = Field(min_length=1, max_length=256)
    description: str | None = Field(default=None, max_length=2048)
    # Optional stable id; generated from the display name when omitted.
    identity_id: str | None = Field(default=None, max_length=128)


class UpdateIdentityBody(BaseModel):
    """Rename, redescribe, or (de)activate one identity. All fields optional."""

    display_name: str | None = Field(default=None, min_length=1, max_length=256)
    description: str | None = Field(default=None, max_length=2048)
    active: bool | None = None


class SetBudgetBody(BaseModel):
    """Set a monthly limit for one budget scope.

    ``period`` is a pinned ``YYYY-MM`` month or ``'*'`` for a recurring budget
    that enforces every month against that month's own spend. The upper bound
    on ``limit_micro_usd`` is a sanity rail so a dollars-vs-micro-USD unit
    mistake fails loudly instead of arming an absurd limit.
    """

    model_config = ConfigDict(extra="forbid")

    period: str
    scope_kind: str
    limit_micro_usd: int = Field(ge=0, le=10**15)
    api_key_id: str | None = None
    identity_id: str | None = None
    alias_id: str | None = None
    pool_id: str | None = None
    deployment_id: str | None = None


# -- Response shapes --------------------------------------------------------


class IdentityView(BaseModel):
    """One identity plus its derived counts for the list/detail views."""

    identity_id: str
    display_name: str
    description: str | None
    active: bool
    is_default: bool
    active_key_count: int
    created_at: str
    updated_at: str


class GrantMatrixView(BaseModel):
    """The full identity x alias grant matrix for one org."""

    identities: list[IdentityView]
    aliases: list[AliasSummary]
    grants: list[dict[str, str]]


class BudgetView(BaseModel):
    """One budget scope with its limit and derived reserved/settled/remaining.

    ``period`` is the row's own key: a pinned ``YYYY-MM`` or ``'*'`` for
    recurring (the balances always meter the month that was queried).
    """

    budget_id: str
    period: str
    scope_kind: str
    api_key_id: str | None
    identity_id: str | None
    alias_id: str | None
    pool_id: str | None
    deployment_id: str | None
    limit_micro_usd: int
    reserved_micro_usd: int
    settled_micro_usd: int
    remaining_micro_usd: int


def _identity_view(summary: IdentitySummary) -> IdentityView:
    """Project a store summary onto the wire shape."""
    identity = summary.identity
    return IdentityView(
        identity_id=identity.identity_id,
        display_name=identity.display_name,
        description=identity.description,
        active=identity.active,
        is_default=summary.is_default,
        active_key_count=summary.active_key_count,
        created_at=identity.created_at,
        updated_at=identity.updated_at,
    )


def _bare_identity_view(identity: IdentityRecord, org_id: str, *, key_count: int) -> IdentityView:
    """Project a single stored identity (no list context) onto the wire shape."""
    return IdentityView(
        identity_id=identity.identity_id,
        display_name=identity.display_name,
        description=identity.description,
        active=identity.active,
        is_default=identity.identity_id == default_identity_id(org_id),
        active_key_count=key_count,
        created_at=identity.created_at,
        updated_at=identity.updated_at,
    )


def _active_key_count(store: GatewayIdentityStore, org_id: str, identity_id: str) -> int:
    """The identity's active-key count from the org listing (0 when absent)."""
    return next(
        (
            summary.active_key_count
            for summary in store.list_identities(org_id)
            if summary.identity.identity_id == identity_id
        ),
        0,
    )


def _budget_view(balance: BudgetBalance) -> BudgetView:
    """Project a store balance onto the wire shape with remaining computed."""
    return BudgetView(
        budget_id=balance.budget_id,
        period=balance.period,
        scope_kind=balance.scope_kind,
        api_key_id=balance.api_key_id,
        identity_id=balance.identity_id,
        alias_id=balance.alias_id,
        pool_id=balance.pool_id,
        deployment_id=balance.deployment_id,
        limit_micro_usd=balance.limit_micro_usd,
        reserved_micro_usd=balance.reserved_micro_usd,
        settled_micro_usd=balance.settled_micro_usd,
        remaining_micro_usd=balance.remaining_micro_usd,
    )


# -- Identities -------------------------------------------------------------


@router.get("/orgs/{org_id}/identities")
def list_identities(org_id: str, client: Client, actor: Actor) -> dict[str, list[IdentityView]]:
    """List the org's identities with active-key counts (members may read)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.USER, not_found=_org_not_found(org_id))
    store = GatewayIdentityStore(client)
    return {"identities": [_identity_view(summary) for summary in store.list_identities(org_id)]}


@router.post("/orgs/{org_id}/identities", status_code=201)
def create_identity(
    org_id: str, body: CreateIdentityBody, client: Client, actor: Actor
) -> IdentityView:
    """Create one named identity under the org (admins only)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    store = GatewayIdentityStore(client)

    if body.identity_id is not None:
        identity_id = body.identity_id.strip()
        if identity_id.startswith(_RESERVED_ID_PREFIX):
            raise ApiError(_RESERVED_PREFIX_MSG, status_code=422)
        if not is_valid_identity_id(identity_id):
            raise ApiError(_INVALID_ID_MSG, status_code=422)
    else:
        identity_id = slugify_identity_id(body.display_name, org_id)

    if store.get_identity(org_id, identity_id) is not None:
        raise ApiError(f"Identity already exists: {identity_id}", status_code=409)

    identity = store.create_identity(
        org_id=org_id,
        identity_id=identity_id,
        display_name=body.display_name.strip(),
        description=_clean_description(body.description),
    )
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.IDENTITIES_CREATE,
        object_type="identity",
        object_id=identity_id,
        after={"display_name": identity.display_name, "description": identity.description},
    )
    return _bare_identity_view(identity, org_id, key_count=0)


@router.patch("/orgs/{org_id}/identities/{identity_id}")
def update_identity(
    org_id: str,
    identity_id: str,
    body: UpdateIdentityBody,
    client: Client,
    actor: Actor,
) -> IdentityView:
    """Rename, redescribe, or (de)activate one identity (admins only)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    store = GatewayIdentityStore(client)

    existing = store.get_identity(org_id, identity_id)
    if existing is None:
        raise ApiError(f"Identity not found: {identity_id}", status_code=404)

    is_default = identity_id == default_identity_id(org_id)
    changes: dict[str, object] = {}
    if body.display_name is not None:
        changes["display_name"] = body.display_name.strip()
    if _describe_field_set(body):
        changes["description"] = _clean_description(body.description)
    if body.active is not None:
        if is_default and not body.active:
            raise ApiError(_DEFAULT_PROTECTED_MSG, status_code=409)
        changes["active"] = body.active
    if not changes:
        raise ApiError(_NO_FIELDS_MSG, status_code=422)

    updated = store.update_identity(org_id=org_id, identity_id=identity_id, changes=changes)
    if updated is None:
        raise ApiError(f"Identity not found: {identity_id}", status_code=404)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.IDENTITIES_UPDATE,
        object_type="identity",
        object_id=identity_id,
        before={
            "display_name": existing.display_name,
            "description": existing.description,
            "active": existing.active,
        },
        after=changes,
    )
    return _bare_identity_view(
        updated, org_id, key_count=_active_key_count(store, org_id, identity_id)
    )


@router.delete("/orgs/{org_id}/identities/{identity_id}")
def disable_identity(org_id: str, identity_id: str, client: Client, actor: Actor) -> IdentityView:
    """Disable one identity (soft: sets active=false). Admins only.

    Disabling is a management state, not a hard revocation: to stop an
    identity's traffic, revoke its keys or remove its grants. The default
    identity cannot be disabled.
    """
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    if identity_id == default_identity_id(org_id):
        raise ApiError(_DEFAULT_PROTECTED_MSG, status_code=409)
    store = GatewayIdentityStore(client)
    if store.get_identity(org_id, identity_id) is None:
        raise ApiError(f"Identity not found: {identity_id}", status_code=404)
    updated = store.update_identity(
        org_id=org_id, identity_id=identity_id, changes={"active": False}
    )
    if updated is None:
        raise ApiError(f"Identity not found: {identity_id}", status_code=404)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.IDENTITIES_DISABLE,
        object_type="identity",
        object_id=identity_id,
        after={"active": False},
    )
    # Disabling does not revoke keys, so report the real active-key count
    # rather than a hardcoded zero that would misstate a still-keyed identity.
    return _bare_identity_view(
        updated, org_id, key_count=_active_key_count(store, org_id, identity_id)
    )


# -- Grants (identity x alias matrix) --------------------------------------


@router.get("/orgs/{org_id}/grants")
def get_grant_matrix(org_id: str, client: Client, actor: Actor) -> GrantMatrixView:
    """Return the identity x alias grant matrix (members may read)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.USER, not_found=_org_not_found(org_id))
    store = GatewayIdentityStore(client)
    return GrantMatrixView(
        identities=[_identity_view(summary) for summary in store.list_identities(org_id)],
        aliases=list(store.list_grantable_aliases(org_id)),
        grants=[
            {"identity_id": edge.identity_id, "alias_id": edge.alias_id}
            for edge in store.list_grants(org_id)
        ],
    )


@router.put("/orgs/{org_id}/identities/{identity_id}/grants/{alias_id}", status_code=200)
def add_grant(
    org_id: str, identity_id: str, alias_id: str, client: Client, actor: Actor
) -> dict[str, bool]:
    """Grant one alias to one identity (idempotent). Admins only."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    store = GatewayIdentityStore(client)
    if store.get_identity(org_id, identity_id) is None:
        raise ApiError(f"Identity not found: {identity_id}", status_code=404)
    if not _alias_is_grantable(store, org_id, alias_id):
        raise ApiError(f"Alias is not usable by this organization: {alias_id}", status_code=404)
    changed = store.add_grant(org_id=org_id, identity_id=identity_id, alias_id=alias_id)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.GRANTS_ADD,
        object_type="grant",
        object_id=f"{identity_id}:{alias_id}",
        after={"identity_id": identity_id, "alias_id": alias_id, "granted": True},
    )
    return {"granted": True, "changed": changed}


@router.delete("/orgs/{org_id}/identities/{identity_id}/grants/{alias_id}", status_code=200)
def remove_grant(
    org_id: str, identity_id: str, alias_id: str, client: Client, actor: Actor
) -> dict[str, bool]:
    """Revoke one alias grant from one identity (idempotent). Admins only."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    store = GatewayIdentityStore(client)
    if store.get_identity(org_id, identity_id) is None:
        raise ApiError(f"Identity not found: {identity_id}", status_code=404)
    changed = store.remove_grant(identity_id=identity_id, alias_id=alias_id)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.GRANTS_REMOVE,
        object_type="grant",
        object_id=f"{identity_id}:{alias_id}",
        after={"identity_id": identity_id, "alias_id": alias_id, "granted": False},
    )
    return {"granted": False, "changed": changed}


# -- Budgets ----------------------------------------------------------------


@router.get("/orgs/{org_id}/budgets")
def list_budgets(
    org_id: str, client: Client, actor: Actor, period: str
) -> dict[str, list[BudgetView]]:
    """List the org's budgets for one month with balances (members may read)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.USER, not_found=_org_not_found(org_id))
    _require_period(period)
    store = GatewayIdentityStore(client)
    return {"budgets": [_budget_view(balance) for balance in store.list_budgets(org_id, period)]}


@router.put("/orgs/{org_id}/budgets")
def set_budget(org_id: str, body: SetBudgetBody, client: Client, actor: Actor) -> BudgetView:
    """Set (create or replace) the monthly limit for one scope. Admins only."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    _require_budget_period(body.period)
    if body.scope_kind not in BUDGET_SCOPE_KINDS:
        raise ApiError(
            f"scope_kind must be one of {', '.join(BUDGET_SCOPE_KINDS)}.", status_code=422
        )
    store = GatewayIdentityStore(client)
    api_key_id, identity_id, alias_id, pool_id, deployment_id = _validated_scope(
        store, client, org_id, body
    )

    budget = store.upsert_budget(
        org_id=org_id,
        period=body.period,
        scope_kind=body.scope_kind,
        limit_micro_usd=body.limit_micro_usd,
        api_key_id=api_key_id,
        identity_id=identity_id,
        alias_id=alias_id,
        pool_id=pool_id,
        deployment_id=deployment_id,
    )
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.BUDGETS_SET,
        object_type="budget",
        object_id=budget.budget_id,
        after={
            "period": body.period,
            "scope_kind": body.scope_kind,
            "limit_micro_usd": body.limit_micro_usd,
            "identity_id": identity_id,
            "alias_id": alias_id,
            "pool_id": pool_id,
            "deployment_id": deployment_id,
        },
    )
    # Re-read balances so the returned meter is authoritative from the seam.
    # A recurring budget is metered against the current month.
    balance_period = _current_period() if body.period == RECURRING_PERIOD else body.period
    balances = store.list_budgets(org_id, balance_period)
    match = next((b for b in balances if b.budget_id == budget.budget_id), None)
    if match is not None:
        return _budget_view(match)
    return BudgetView(
        budget_id=budget.budget_id,
        period=budget.period,
        scope_kind=budget.scope_kind,
        api_key_id=budget.api_key_id,
        identity_id=budget.identity_id,
        alias_id=budget.alias_id,
        pool_id=budget.pool_id,
        deployment_id=budget.deployment_id,
        limit_micro_usd=budget.limit_micro_usd,
        reserved_micro_usd=0,
        settled_micro_usd=0,
        remaining_micro_usd=budget.limit_micro_usd,
    )


@router.delete("/orgs/{org_id}/budgets/{budget_id}", status_code=200)
def delete_budget(org_id: str, budget_id: str, client: Client, actor: Actor) -> dict[str, bool]:
    """Remove one budget scope (setting it back to unlimited). Admins only."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    store = GatewayIdentityStore(client)
    deleted = store.delete_budget(org_id=org_id, budget_id=budget_id)
    if not deleted:
        raise ApiError(f"Budget not found: {budget_id}", status_code=404)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.BUDGETS_DELETE,
        object_type="budget",
        object_id=budget_id,
        after={"deleted": True},
    )
    return {"deleted": True}


# -- Validation helpers -----------------------------------------------------


def _validated_scope(  # noqa: C901, PLR0912 - one arm per budget scope, exhaustive on purpose
    store: GatewayIdentityStore, client: SupabaseClient, org_id: str, body: SetBudgetBody
) -> tuple[str | None, str | None, str | None, str | None, str | None]:
    """Validate a budget body's identifier set against its scope and return it.

    Enforces the same identifier shape as the DB CHECK (team carries none,
    identity carries identity_id, key carries api_key_id, model carries
    alias_id, pool carries alias+pool, deployment carries
    alias+pool+deployment) and verifies referenced keys/identities/aliases
    belong to the org, so a malformed scope fails as a clean 422 rather than a
    raw constraint violation.
    """
    match body.scope_kind:
        case "team":
            _reject_extraneous(body, allowed=set())
            return (None, None, None, None, None)
        case "identity":
            _reject_extraneous(body, allowed={"identity_id"})
            if body.identity_id is None:
                raise ApiError(_IDENTITY_SCOPE_MSG, status_code=422)
            if store.get_identity(org_id, body.identity_id) is None:
                raise ApiError(f"Identity not found: {body.identity_id}", status_code=404)
            return (None, body.identity_id, None, None, None)
        case "key":
            _reject_extraneous(body, allowed={"api_key_id"})
            if body.api_key_id is None:
                raise ApiError(_KEY_SCOPE_MSG, status_code=422)
            _require_org_api_key(client, org_id, body.api_key_id)
            return (body.api_key_id, None, None, None, None)
        case "model":
            _reject_extraneous(body, allowed={"alias_id"})
            if body.alias_id is None:
                raise ApiError(_MODEL_SCOPE_MSG, status_code=422)
            _require_grantable_alias(store, org_id, body.alias_id)
            return (None, None, body.alias_id, None, None)
        case "pool":
            _reject_extraneous(body, allowed={"alias_id", "pool_id"})
            if body.alias_id is None or body.pool_id is None:
                raise ApiError(_POOL_SCOPE_MSG, status_code=422)
            _require_grantable_alias(store, org_id, body.alias_id)
            return (None, None, body.alias_id, body.pool_id, None)
        case "deployment":
            _reject_extraneous(body, allowed={"alias_id", "pool_id", "deployment_id"})
            if body.alias_id is None or body.pool_id is None or body.deployment_id is None:
                raise ApiError(_DEPLOYMENT_SCOPE_MSG, status_code=422)
            _require_grantable_alias(store, org_id, body.alias_id)
            return (None, None, body.alias_id, body.pool_id, body.deployment_id)
        case _:
            raise ApiError(
                f"scope_kind must be one of {', '.join(BUDGET_SCOPE_KINDS)}.", status_code=422
            )


def _require_org_api_key(client: SupabaseClient, org_id: str, api_key_id: str) -> None:
    """Fail with a 404 if an API key does not exist inside this org.

    The message never distinguishes a foreign org's key from an absent one, so
    the route is not a cross-tenant key-existence oracle.
    """
    row = find_one_by_columns(client, "api_keys", {"id": api_key_id})
    if row is None or str(row.get("org_id")) != org_id:
        raise ApiError(f"API key not found: {api_key_id}", status_code=404)


def _require_grantable_alias(store: GatewayIdentityStore, org_id: str, alias_id: str) -> None:
    """Fail with a 404 if an alias is not active and usable by the org."""
    if not _alias_is_grantable(store, org_id, alias_id):
        raise ApiError(f"Alias not usable by this organization: {alias_id}", status_code=404)


def _reject_extraneous(body: SetBudgetBody, *, allowed: set[str]) -> None:
    """Fail if the body carries a scope identifier the scope does not own."""
    supplied = {
        name
        for name in ("api_key_id", "identity_id", "alias_id", "pool_id", "deployment_id")
        if getattr(body, name) is not None
    }
    extraneous = supplied - allowed
    if extraneous:
        raise ApiError(
            f"A {body.scope_kind} budget must not carry: {', '.join(sorted(extraneous))}.",
            status_code=422,
        )


def _alias_is_grantable(store: GatewayIdentityStore, org_id: str, alias_id: str) -> bool:
    """Return whether an alias is active and usable by the org."""
    return any(alias.alias_id == alias_id for alias in store.list_grantable_aliases(org_id))


def _require_period(period: str) -> None:
    """Fail with a 422 if a period is not a valid ``YYYY-MM`` month key."""
    if not _PERIOD_PATTERN.fullmatch(period):
        raise ApiError(_PERIOD_MSG, status_code=422)


def _require_budget_period(period: str) -> None:
    """Fail with a 422 unless a budget period is ``YYYY-MM`` or recurring.

    Reads stay pinned-month only (`_require_period`): the balances seam meters
    a concrete month, and recurring rows are folded into every month's read.
    """
    if period != RECURRING_PERIOD and not _PERIOD_PATTERN.fullmatch(period):
        raise ApiError(_BUDGET_PERIOD_MSG, status_code=422)


def _current_period() -> str:
    """The current UTC month key, matching the enforcement seam's UTC bucket."""
    return datetime.now(tz=UTC).strftime("%Y-%m")


def _clean_description(description: str | None) -> str | None:
    """Normalize an optional description: blank becomes None."""
    if description is None:
        return None
    trimmed = description.strip()
    return trimmed or None


def _describe_field_set(body: UpdateIdentityBody) -> bool:
    """Return whether the PATCH body explicitly set description (incl. to null).

    Pydantic cannot distinguish an omitted field from an explicit null on a
    plain optional, so a description edit is signalled by the field being in the
    model's ``model_fields_set``.
    """
    return "description" in body.model_fields_set


def _org_not_found(org_id: str) -> str:
    """The uniform not-found message shared by every route in this module."""
    return f"Organization not found: {org_id}"
