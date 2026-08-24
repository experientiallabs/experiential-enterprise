# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Admin routes for platform-wide credit/spend-unlock settings.

One coherent surface over the ``public.app_settings`` singleton, backing the
admin Platform panel: the welcome grant amount, the YC grant amount, the
pre-verify spend allowance, and the spend-unlock requirement mode (email vs.
card). The gateway spend gate (owned by the promo-caps lane) reads
``pre_verify_allowance_micro_usd`` directly; the grant functions read the two
grant amounts; and the web spend-unlock layer reads the requirement mode. These
routes are the platform-admin read/write surface for all of them.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import RequestActor, get_request_actor
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.app_settings_store import (
    PRE_VERIFY_ALLOWANCE_OFF_MICRO_USD,
    PRE_VERIFY_ALLOWANCE_ON_MICRO_USD,
    AppSettingsStore,
    CreditGateSettings,
)

router = APIRouter(prefix="/api", tags=["platform-settings"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

Client = Annotated[SupabaseClient, Depends(get_supabase)]


class PreVerifyAllowanceRequest(BaseModel):
    """Body of the admin pre-verify allowance toggle."""

    # True turns the allowance ON ($1 / 1_000_000 micro-USD): a new user may
    # spend up to $1 of credit before verifying. False turns it OFF (0): full
    # email verification required for all credits.
    enabled: bool


class GrantAmountRequest(BaseModel):
    """Body of a grant-amount write (welcome or YC), in micro-USD."""

    micro_usd: int


class SpendUnlockRequirementRequest(BaseModel):
    """Body of the spend-unlock mode write."""

    requirement: str


def _view(settings: CreditGateSettings) -> JsonObject:
    """Project every credit/gate knob plus the derived pre-verify on/off state."""
    return {
        "welcome_grant_micro_usd": settings.welcome_grant_micro_usd,
        "yc_grant_micro_usd": settings.yc_grant_micro_usd,
        "pre_verify_allowance_micro_usd": settings.pre_verify_allowance_micro_usd,
        "pre_verify_enabled": settings.pre_verify_allowance_micro_usd > 0,
        "spend_unlock_requirement": settings.spend_unlock_requirement,
    }


def _require_admin(actor: RequestActor) -> None:
    """Platform admins only; everyone else gets the standard not-found."""
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)


@router.get("/admin/settings/credit-gating")
def get_credit_gating(client: Client, actor: Actor) -> JsonObject:
    """Return the consolidated credit/spend-unlock settings. Platform admins only."""
    _require_admin(actor)
    return _view(AppSettingsStore(client).get_credit_gate_settings())


@router.put("/admin/settings/pre-verify-allowance")
def put_pre_verify_allowance(
    body: PreVerifyAllowanceRequest, client: Client, actor: Actor
) -> JsonObject:
    """Turn the pre-verify spend allowance ON ($1) or OFF (0).

    ON lets a new user spend up to $1 of granted credit before proving inbox
    ownership; OFF requires email verification for all credits. The gateway
    spend gate reads the resulting value. Platform admins only.
    """
    _require_admin(actor)
    store = AppSettingsStore(client)
    micro_usd = (
        PRE_VERIFY_ALLOWANCE_ON_MICRO_USD if body.enabled else PRE_VERIFY_ALLOWANCE_OFF_MICRO_USD
    )
    store.set_pre_verify_allowance_micro_usd(micro_usd)
    return _view(store.get_credit_gate_settings())


@router.put("/admin/settings/welcome-grant")
def put_welcome_grant(body: GrantAmountRequest, client: Client, actor: Actor) -> JsonObject:
    """Set the signup welcome grant amount (micro-USD). Platform admins only."""
    _require_admin(actor)
    store = AppSettingsStore(client)
    _write_or_400(lambda: store.set_welcome_grant_micro_usd(body.micro_usd))
    return _view(store.get_credit_gate_settings())


@router.put("/admin/settings/yc-grant")
def put_yc_grant(body: GrantAmountRequest, client: Client, actor: Actor) -> JsonObject:
    """Set the YC launch grant amount (micro-USD). Platform admins only."""
    _require_admin(actor)
    store = AppSettingsStore(client)
    _write_or_400(lambda: store.set_yc_grant_micro_usd(body.micro_usd))
    return _view(store.get_credit_gate_settings())


@router.put("/admin/settings/spend-unlock-requirement")
def put_spend_unlock_requirement(
    body: SpendUnlockRequirementRequest, client: Client, actor: Actor
) -> JsonObject:
    """Set what unlocks spend for a locked org: ``email`` or ``card``.

    Only the CONDITION that sets ``organizations.spend_unlocked_at`` changes; the
    P1025 spend gate is untouched. Platform admins only.
    """
    _require_admin(actor)
    store = AppSettingsStore(client)
    try:
        store.set_spend_unlock_requirement(body.requirement)
    except ValueError as error:
        raise ApiError(str(error), status_code=400) from error
    return _view(store.get_credit_gate_settings())


def _write_or_400(write: Callable[[], int]) -> None:
    """Run a grant-amount write, mapping the typed-boundary ValueError to 400."""
    try:
        write()
    except ValueError as error:
        raise ApiError(str(error), status_code=400) from error
