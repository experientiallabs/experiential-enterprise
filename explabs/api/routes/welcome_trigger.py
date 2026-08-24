# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Admin control for the re-triggerable welcome celebration.

A platform admin arms the confetti + integration-prompt modal to re-show on
members' next workspace enter, per org or across a whole label cohort, choosing
the announced credit figure and whether to surface the API key. Superadmin-gated
so both the admin panel (via the backend data source) and the ``xpladmin_`` key
(the cohort backfill) reach it. Members never write the trigger; they only read
their own org's state from the web session.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.routes import get_supabase
from explabs.api.tenancy import RequestActor, get_request_actor, require_platform_admin
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.welcome_trigger_store import WelcomeTriggerStore

router = APIRouter(prefix="/api", tags=["welcome-trigger"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]


class WelcomeTriggerBody(BaseModel):
    """Operator request to arm/disarm one org's welcome celebration."""

    model_config = ConfigDict(frozen=True)

    active: bool
    # The credit figure to announce; omit/null to fall back to the launch grant.
    display_credit_usd: float | None = None
    show_api_key: bool = True


class WelcomeTriggerByLabelBody(WelcomeTriggerBody):
    """Same, applied to every org carrying ``label``."""

    label: str


@router.get("/admin/orgs/{org_id}/welcome-trigger")
def get_admin_welcome_trigger(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Read one org's current welcome-trigger state (superadmin).

    The admin detail page seeds its card from this so it shows the org's real
    persisted state instead of fabricated defaults. ``trigger`` is null when the
    org has never been armed.
    """
    require_platform_admin(actor)
    trigger = WelcomeTriggerStore(client).get_trigger(org_id)
    if trigger is None:
        return {"trigger": None}
    return {
        "trigger": {
            "org_id": trigger.org_id,
            "active": trigger.active,
            "display_credit_usd": trigger.display_credit_usd,
            "show_api_key": trigger.show_api_key,
            "triggered_at": trigger.triggered_at,
        }
    }


@router.put("/admin/orgs/{org_id}/welcome-trigger")
def put_admin_welcome_trigger(
    org_id: str,
    body: WelcomeTriggerBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Arm or disarm the welcome celebration for one org (superadmin)."""
    require_platform_admin(actor)
    trigger = WelcomeTriggerStore(client).set_trigger(
        org_id,
        active=body.active,
        display_credit_usd=body.display_credit_usd,
        show_api_key=body.show_api_key,
        updated_by=actor.user_id,
    )
    return {
        "org_id": trigger.org_id,
        "active": trigger.active,
        "display_credit_usd": trigger.display_credit_usd,
        "show_api_key": trigger.show_api_key,
        "triggered_at": trigger.triggered_at,
    }


@router.post("/admin/welcome-triggers/by-label")
def post_admin_welcome_trigger_by_label(
    body: WelcomeTriggerByLabelBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Arm/disarm the welcome celebration for every org with a label (superadmin).

    The cohort lane: e.g. arm the celebration for all ``yc`` orgs with $526 in
    one call. Returns the affected org count.
    """
    require_platform_admin(actor)
    affected = WelcomeTriggerStore(client).apply_by_label(
        body.label,
        active=body.active,
        display_credit_usd=body.display_credit_usd,
        show_api_key=body.show_api_key,
        updated_by=actor.user_id,
    )
    return {"label": body.label, "active": body.active, "affected_orgs": affected}
