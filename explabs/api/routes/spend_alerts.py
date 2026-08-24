# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Spend-alert management routes: the soft counterpart to budgets and caps.

Rules live in ``gateway_spend_alerts`` (org monthly spend threshold, or
fraction-of-budget consumed) and fire at most once per rule per UTC month via
the pg_cron -> web delivery tick; this module is only the dashboard CRUD over
the rules plus the fired history. Reads admit any member; mutations demand an
org admin, exactly like budgets. These paths are NOT in app.py's
``_CUSTOMER_KEY_ROUTES`` allowlist, so a customer ``xpl_`` key never reaches
them.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator

from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import SupabaseClient
from explabs.db.stores.gateway_identity_store import GatewayIdentityStore
from explabs.db.stores.gateway_spend_alert_store import (
    DuplicateSpendAlertError,
    GatewaySpendAlertStore,
    SpendAlertEventRecord,
    SpendAlertRecord,
)

router = APIRouter(prefix="/api", tags=["spend-alerts"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

_ORG_THRESHOLD_MSG = "An org_monthly_spend alert requires threshold_micro_usd and no budget fields."
_DUPLICATE_MSG = "An identical spend alert already exists."
_BUDGET_FRACTION_MSG = (
    "A budget_fraction alert requires budget_id and threshold_fraction, and no threshold_micro_usd."
)


class CreateSpendAlertBody(BaseModel):
    """Create one alert rule; the field set is fixed by ``kind``.

    The threshold upper bound is a sanity rail so a dollars-vs-micro-USD unit
    mistake fails loudly.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["org_monthly_spend", "budget_fraction"]
    threshold_micro_usd: int | None = Field(default=None, gt=0, le=10**15)
    budget_id: str | None = None
    threshold_fraction: float | None = Field(default=None, gt=0, le=1)
    notify_email: str = Field(min_length=3, max_length=320)

    @field_validator("notify_email")
    @classmethod
    def _email_shape(cls, value: str) -> str:
        """Match the DB check: an '@' preceded by at least one character."""
        if value.find("@") < 1:
            msg = "notify_email must be an email address"
            raise ValueError(msg)
        return value


class SpendAlertEventView(BaseModel):
    """One fired (alert, month) claim with its delivery state."""

    period: str
    fired_at: str
    measured_micro_usd: int
    threshold_micro_usd: int
    delivered_at: str | None
    delivery_error: str | None


class SpendAlertView(BaseModel):
    """One alert rule plus its most recent fired event, if any."""

    alert_id: str
    kind: str
    threshold_micro_usd: int | None
    budget_id: str | None
    threshold_fraction: float | None
    notify_email: str
    created_at: str
    last_event: SpendAlertEventView | None


def _event_view(event: SpendAlertEventRecord) -> SpendAlertEventView:
    """Project a store event onto the wire shape."""
    return SpendAlertEventView(
        period=event.period,
        fired_at=event.fired_at,
        measured_micro_usd=event.measured_micro_usd,
        threshold_micro_usd=event.threshold_micro_usd,
        delivered_at=event.delivered_at,
        delivery_error=event.delivery_error,
    )


def _alert_view(
    alert: SpendAlertRecord, last_event: SpendAlertEventRecord | None
) -> SpendAlertView:
    """Project a store rule (and its newest event) onto the wire shape."""
    return SpendAlertView(
        alert_id=alert.alert_id,
        kind=alert.kind,
        threshold_micro_usd=alert.threshold_micro_usd,
        budget_id=alert.budget_id,
        threshold_fraction=alert.threshold_fraction,
        notify_email=alert.notify_email,
        created_at=alert.created_at,
        last_event=_event_view(last_event) if last_event is not None else None,
    )


def _org_not_found(org_id: str) -> str:
    """The uniform not-found message shared by every route in this module."""
    return f"Organization not found: {org_id}"


@router.get("/orgs/{org_id}/spend-alerts")
def list_spend_alerts(org_id: str, client: Client, actor: Actor) -> dict[str, list[SpendAlertView]]:
    """List the org's alert rules with their newest fired event (members)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.USER, not_found=_org_not_found(org_id))
    store = GatewaySpendAlertStore(client)
    alerts = store.list_alerts(org_id)
    events = store.list_events(tuple(alert.alert_id for alert in alerts))
    newest: dict[str, SpendAlertEventRecord] = {}
    for event in events:
        # Events arrive newest-first; keep the first one seen per rule.
        newest.setdefault(event.alert_id, event)
    return {"alerts": [_alert_view(alert, newest.get(alert.alert_id)) for alert in alerts]}


@router.post("/orgs/{org_id}/spend-alerts", status_code=201)
def create_spend_alert(
    org_id: str, body: CreateSpendAlertBody, client: Client, actor: Actor
) -> SpendAlertView:
    """Create one alert rule (admins only)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    match body.kind:
        case "org_monthly_spend":
            if (
                body.threshold_micro_usd is None
                or body.budget_id is not None
                or body.threshold_fraction is not None
            ):
                raise ApiError(_ORG_THRESHOLD_MSG, status_code=422)
        case "budget_fraction":
            if (
                body.budget_id is None
                or body.threshold_fraction is None
                or body.threshold_micro_usd is not None
            ):
                raise ApiError(_BUDGET_FRACTION_MSG, status_code=422)
            budgets = GatewayIdentityStore(client)
            if budgets.get_budget(org_id, body.budget_id) is None:
                raise ApiError(f"Budget not found: {body.budget_id}", status_code=404)
    store = GatewaySpendAlertStore(client)
    try:
        alert = store.create_alert(
            org_id=org_id,
            kind=body.kind,
            threshold_micro_usd=body.threshold_micro_usd,
            budget_id=body.budget_id,
            threshold_fraction=body.threshold_fraction,
            notify_email=body.notify_email,
            created_by=actor.user_id,
        )
    except DuplicateSpendAlertError as error:
        raise ApiError(_DUPLICATE_MSG, status_code=409) from error
    return _alert_view(alert, None)


@router.delete("/orgs/{org_id}/spend-alerts/{alert_id}", status_code=200)
def delete_spend_alert(org_id: str, alert_id: str, client: Client, actor: Actor) -> dict[str, bool]:
    """Remove one alert rule (admins only)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    store = GatewaySpendAlertStore(client)
    deleted = store.delete_alert(org_id=org_id, alert_id=alert_id)
    if not deleted:
        raise ApiError(f"Spend alert not found: {alert_id}", status_code=404)
    return {"deleted": True}
