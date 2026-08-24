# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The YC launch grant: apply the `yc` org label + a launch credit grant.

"YC company" is the generalized ``yc`` org label (public.org_labels); the launch
credit is a ``yc_launch`` grant in ``credit_ledger`` carrying its own expiry.
One transactional function (``apply_yc_launch_grant``) does both, so the two
entry points share it:

* Self-serve ``POST /api/orgs/{org_id}/yc-claim`` — any org member (or the org's
  ``xpl_`` key during the pasted onboarding prompt) claims once, with the launch
  defaults ($526 from app_settings, 3-month expiry). Idempotent: a replay
  returns the current state, never a second grant.
* Operator ``POST /api/admin/orgs/{org_id}/yc-grant`` — a platform admin marks
  any org a YC company and sets the grant amount + expiry (the admin panel's
  "org tags" control). Superadmin-gated.

Abuse control on the self-serve lane is the per-org idempotency (the grant's
unique source_ref and the label's unique key), the free-credit caps, and the
per-apply Slack ping.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.routes import get_supabase
from explabs.api.services.billing_notifications import notify_yc_claim
from explabs.api.tenancy import (
    OrgRole,
    RequestActor,
    get_request_actor,
    require_org_role,
    require_platform_admin,
)
from explabs.db.repositories import JsonObject, RepositoryError, SupabaseClient
from explabs.db.stores.api_key_store import ApiKeyStore
from explabs.db.stores.app_settings_store import AppSettingsStore
from explabs.db.stores.yc_claim_store import YC_GRANT_USD, LaunchGrantResult, YcClaimStore

router = APIRouter(prefix="/api", tags=["yc"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]


@router.post("/orgs/{org_id}/yc-claim")
def post_yc_claim(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Self-serve: mark the actor's org a YC company + apply the launch grant.

    Any org member may claim, and so may the org's own ``xpl_`` key (the agent
    lane of the pasted onboarding prompt). Applies the ``yc`` label and the
    ``$526`` launch grant (3-month expiry), folding the ``$20`` welcome promo
    in — one transaction. Idempotent per org: a second claim returns the
    current state (no second grant, no 409). The Slack ping fires only on the
    first apply and never fails the claim.
    """
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )
    result = YcClaimStore(client).apply_launch_grant(
        org_id,
        _launch_amount_usd(client),
        None,
        _resolve_created_by(client, actor),
    )
    _ping_on_new_apply(result, org_id)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.YC_CLAIM,
        object_type="organization",
        object_id=org_id,
        after={"granted_usd": result.granted_usd, "expires_at": result.expires_at},
    )
    return {
        "granted_usd": result.granted_usd,
        "expires_at": result.expires_at,
        "balance_usd": result.balance_usd,
    }


class AdminYcGrantBody(BaseModel):
    """Operator request to mark an org YC and grant credit with an expiry."""

    model_config = ConfigDict(frozen=True)

    # Grant size in USD; omit to use the launch default (app_settings).
    amount_usd: float | None = None
    # ISO 8601 expiry; omit to default to 3 months from now.
    expires_at: str | None = None


@router.post("/admin/orgs/{org_id}/yc-grant")
def post_admin_yc_grant(
    org_id: str,
    body: AdminYcGrantBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Operator: mark any org a YC company and set the grant amount + expiry.

    The admin-panel "org tags" control (apply the ``yc`` tag with a chosen grant
    amount and expiry date; 3-month default). Superadmin-only. Same idempotent,
    transactional apply the self-serve lane uses, so re-running is safe.
    """
    require_platform_admin(actor)
    amount = body.amount_usd if body.amount_usd is not None else _launch_amount_usd(client)
    result = YcClaimStore(client).apply_launch_grant(org_id, amount, body.expires_at, actor.user_id)
    _ping_on_new_apply(result, org_id)
    return {
        "granted_usd": result.granted_usd,
        "expires_at": result.expires_at,
        "balance_usd": result.balance_usd,
        "newly_applied": result.newly_applied,
        "org_slug": result.org_slug,
    }


def _launch_amount_usd(client: SupabaseClient) -> float:
    """The configured launch grant in USD, or the launch default.

    Reads ``app_settings.yc_grant_micro_usd``; falls back to ``YC_GRANT_USD``
    when app_settings is unseeded (most fixtures) or the value is non-positive.
    """
    try:
        micro = AppSettingsStore(client).get_credit_gate_settings().yc_grant_micro_usd
    except (RepositoryError, LookupError, ValueError, TypeError):
        return YC_GRANT_USD
    return micro / 1_000_000 if micro > 0 else YC_GRANT_USD


def _ping_on_new_apply(result: LaunchGrantResult, org_id: str) -> None:
    """Best-effort Slack ping, only when the grant was freshly applied."""
    if result.newly_applied:
        notify_yc_claim(
            org_name=result.org_name,
            org_slug=result.org_slug,
            user_email=None,
            org_id=org_id,
        )


def _resolve_created_by(client: SupabaseClient, actor: RequestActor) -> str | None:
    """Provenance user for the label/grant, or None for the system sentinel.

    A session actor is a real user id. An api-key actor resolves to the human
    who minted the key; a creatorless key yields None (the grant no longer keys
    uniqueness on the user, so a missing creator is fine, not a 403).
    """
    if actor.api_key_org_id is None:
        return actor.user_id
    if actor.api_key_id is not None:
        return ApiKeyStore(client).find_creator(actor.api_key_id)
    return None
