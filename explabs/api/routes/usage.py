# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Usage routes: the authoritative credit counters and their controls."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.credits import (
    load_organization,
    load_organization_with_yc,
    organization_credit,
    organization_credit_view,
    platform_org_usage,
)
from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.api.training_defaults import DEFAULT_CREATE_TRAINING_CAP_USD, MAX_TRAINING_CAP_USD
from explabs.db.repositories import JsonObject, SupabaseClient, update_by_id
from explabs.db.stores.credit_ledger_store import CreditLedgerStore

router = APIRouter(prefix="/api", tags=["usage"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]


@router.get("/orgs/usage")
def get_platform_org_usage(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Return every organization's spend and credit counters in one response.

    The admin panel's bulk read: the counters live on the organizations row,
    so the response cost is one paged select however many tenants exist.
    Platform admins only; anyone else gets the standard not-found.

    Registered before ``/orgs/{org_id}/usage`` so the literal path wins.
    """
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)
    return {"orgs": platform_org_usage(client)}


@router.get("/orgs/{org_id}/usage")
def get_org_usage(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Return the organization's credit counters: spend, billable, granted, balance.

    Counters only, off one organizations read — this used to be the heaviest
    read in the app (8+ queries, three unbounded paging loops folding the
    retired per-model and per-endpoint breakdowns), and the /credits page it
    now feeds shows exactly the trigger-maintained figures the enforcement
    gate reads. Usage-by-model belongs to the telemetry surfaces. The ``yc``
    block mirrors the budget payload's.
    """
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )
    org, yc = load_organization_with_yc(client, org_id)
    return {"credit": {**organization_credit_view(org), "yc": yc}}


@router.get("/orgs/{org_id}/budget")
def get_org_budget(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Return the lightweight credit counters for live UI refreshes."""
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )
    # ONE organizations read for every part of this payload. The sidebar polls
    # this route every 3s on every workspace page, which makes it the
    # highest-volume authenticated request in the product; the training cap is
    # a column on the row the credit counters come from, and the YC claim
    # state rides the same read as an embedded resource.
    org, yc = load_organization_with_yc(client, org_id)
    credit = dict(organization_credit_view(org))
    # The automatic-training ceiling rides the budget read: it is a spend
    # control, and the Usage page is where spend is read and governed.
    raw = org.get("training_cap_usd")
    credit["training_cap_usd"] = float(raw) if isinstance(raw, (int, float)) else None
    credit["training_cap_default_usd"] = DEFAULT_CREATE_TRAINING_CAP_USD
    # The /yc launch grant state (or null): CreditBalanceCard's prominent
    # variant and the YC-aware error copy key on an unexpired claim.
    credit["yc"] = yc
    return credit


class TrainingCapRequest(BaseModel):
    """Body of the automatic-training ceiling write."""

    # Null resets to the platform default; a number binds every automatic run
    # this org's creations queue from the next creation on.
    training_cap_usd: float | None = Field(default=None, gt=0.0, le=MAX_TRAINING_CAP_USD)


@router.put("/orgs/{org_id}/training-cap")
def set_training_cap(
    org_id: str,
    body: TrainingCapRequest,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Set (or reset) the org's ceiling for automatic training runs.

    Admin-gated like every other spend control: this authorizes real dollars
    per creation. The cap binds the sweep's pre-spend projection at queue
    time, so a change governs the very next creation.
    """
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.ADMIN,
        not_found=f"Organization not found: {org_id}",
    )
    update_by_id(client, "organizations", org_id, {"training_cap_usd": body.training_cap_usd})
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ORG_TRAINING_CAP_SET,
        object_type="organization",
        object_id=org_id,
        after={"training_cap_usd": body.training_cap_usd},
    )
    return {
        "training_cap_usd": body.training_cap_usd,
        "training_cap_default_usd": DEFAULT_CREATE_TRAINING_CAP_USD,
    }


@router.get("/orgs/{org_id}/credit/ledger")
def get_org_credit_ledger(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    limit: int = 50,
) -> JsonObject:
    """Return the organization's credit history, newest first.

    Grants, top-ups, and adjustments as recorded in the append-only ledger;
    the Settings usage page renders this next to the balance so "where did
    my credits come from" has an answer.
    """
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )
    entries = CreditLedgerStore(client).list_for_org(org_id, limit=limit)
    return {"entries": [entry.api_view() for entry in entries]}


class FreeCreditCapsRequest(BaseModel):
    """Body of the admin free-credit cap-lift write."""

    # True lifts the free-credit daily caps ($50/day org, $25/day per model)
    # for the org; false restores them.
    lifted: bool


@router.put("/admin/orgs/{org_id}/free-credit-caps")
def put_admin_free_credit_caps(
    org_id: str,
    body: FreeCreditCapsRequest,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Lift (or restore) the free-credit daily caps for one organization.

    The caps otherwise bind until the org's first paid top-up
    (``gateway_org_free_credit_funded`` in migration 20260819234500); this is
    the support override for orgs that should spend uncapped on granted
    credits. Platform admins only; anyone else gets the standard not-found.
    """
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)
    load_organization(client, org_id)
    lifted_at = datetime.now(UTC).isoformat() if body.lifted else None
    update_by_id(client, "organizations", org_id, {"free_credit_caps_lifted_at": lifted_at})
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.BILLING_FREE_CREDIT_CAPS_SET,
        object_type="organization",
        object_id=org_id,
        after={"free_credit_caps_lifted_at": lifted_at},
    )
    return {"free_credit_caps_lifted_at": lifted_at}


@router.post("/admin/orgs/{org_id}/credit-grants", status_code=201)
def post_admin_credit_grant(
    org_id: str,
    payload: JsonObject,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Record an admin credit grant (or negative adjustment) for one org.

    Replaces the usage-limit editor: support raises headroom by granting
    credits, and corrects mistakes with a negative adjustment, both leaving
    an auditable ledger entry. Platform admins only; anyone else gets the
    standard not-found.
    """
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)
    amount = payload.get("amount_usd")
    if isinstance(amount, bool) or not isinstance(amount, int | float) or amount == 0:
        msg = "amount_usd must be a non-zero number"
        raise ApiError(msg, status_code=400)
    reason = payload.get("reason")
    if reason is not None and not isinstance(reason, str):
        msg = "reason must be a string"
        raise ApiError(msg, status_code=400)
    store = CreditLedgerStore(client)
    entry = store.insert(
        org_id=org_id,
        entry_type="grant" if amount > 0 else "adjustment",
        amount_usd=float(amount),
        reason=reason or None,
        source="admin",
        created_by=actor.user_id,
    )
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.BILLING_CREDIT_GRANT,
        object_type="credit_ledger_entry",
        object_id=entry.id,
        after=entry.api_view(),
    )
    return {"entry": entry.api_view(), "credit": organization_credit(client, org_id)}
