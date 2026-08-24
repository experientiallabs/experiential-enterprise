# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for gateway spend alerts: rules and their fired-event ledger.

The management API CRUDs ``gateway_spend_alerts`` rules here as service_role.
Firing is NOT this store's job: the pg_cron tick calls the SECURITY DEFINER
``gateway_spend_alerts_due()`` claim seam through the web delivery route, so
measurement stays in the database next to the budget gates it warns about.
This store only manages rules and reads the fired history for the dashboard.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import (
    DeleteCapableQuery,
    RepositoryError,
    SupabaseClient,
    is_unique_violation,
    result_rows,
)
from explabs.db.stores.transitions import now_iso

# The two rule kinds; the DB CHECK enforces the exact field set each carries
# (org_monthly_spend: threshold_micro_usd; budget_fraction: budget_id +
# threshold_fraction).
SPEND_ALERT_KINDS = ("org_monthly_spend", "budget_fraction")

_ALERT_COLUMNS = (
    "alert_id, org_id, kind, threshold_micro_usd, budget_id, threshold_fraction, "
    "notify_email, created_at, updated_at"
)
_EVENT_COLUMNS = (
    "alert_id, period, fired_at, measured_micro_usd, threshold_micro_usd, "
    "delivered_at, delivery_error"
)


class DuplicateSpendAlertError(Exception):
    """Raised when an identical alert rule already exists for the org."""


class SpendAlertRecord(BaseModel):
    """Typed snapshot of a ``gateway_spend_alerts`` rule row."""

    model_config = ConfigDict(frozen=True)

    alert_id: str
    org_id: str
    kind: Literal["org_monthly_spend", "budget_fraction"]
    threshold_micro_usd: int | None
    budget_id: str | None
    threshold_fraction: float | None
    notify_email: str
    created_at: str
    updated_at: str


class SpendAlertEventRecord(BaseModel):
    """One fired (alert, month) claim with its delivery state."""

    model_config = ConfigDict(frozen=True)

    alert_id: str
    period: str
    fired_at: str
    measured_micro_usd: int
    threshold_micro_usd: int
    delivered_at: str | None
    delivery_error: str | None


class GatewaySpendAlertStore:
    """Reads and writes over the spend-alert management tables."""

    def __init__(self, client: SupabaseClient) -> None:
        """Bind the store to a Supabase client (service_role in production)."""
        self._client = client

    def list_alerts(self, org_id: str) -> tuple[SpendAlertRecord, ...]:
        """Return the org's alert rules, oldest first."""
        rows = result_rows(
            self._client.table("gateway_spend_alerts")
            .select(_ALERT_COLUMNS)
            .eq("org_id", org_id)
            .order("created_at", desc=False)
            .execute()
        )
        return tuple(SpendAlertRecord.model_validate(row) for row in rows)

    def create_alert(
        self,
        *,
        org_id: str,
        kind: str,
        threshold_micro_usd: int | None,
        budget_id: str | None,
        threshold_fraction: float | None,
        notify_email: str,
        created_by: str | None,
    ) -> SpendAlertRecord:
        """Insert one alert rule; reject an exact duplicate.

        Raises:
            DuplicateSpendAlertError: If an identical rule (same kind, target,
                and threshold) already exists for the org.
        """
        # Stamp the generated columns here rather than leaning on their DB
        # defaults so the returned row is complete for the typed record without
        # a follow-up read (same convention as GatewayIdentityStore).
        stamp = now_iso()
        try:
            rows = result_rows(
                self._client.table("gateway_spend_alerts")
                .insert(
                    {
                        "alert_id": f"alert-{uuid.uuid4().hex}",
                        "org_id": org_id,
                        "kind": kind,
                        "threshold_micro_usd": threshold_micro_usd,
                        "budget_id": budget_id,
                        "threshold_fraction": threshold_fraction,
                        "notify_email": notify_email,
                        "created_by": created_by,
                        "created_at": stamp,
                        "updated_at": stamp,
                    }
                )
                .execute()
            )
        except Exception as error:
            if is_unique_violation(error):
                msg = "an identical spend alert already exists"
                raise DuplicateSpendAlertError(msg) from error
            raise
        return SpendAlertRecord.model_validate(rows[0])

    def delete_alert(self, *, org_id: str, alert_id: str) -> bool:
        """Remove one alert rule; return whether a row was deleted."""
        query = self._client.table("gateway_spend_alerts")
        if not isinstance(query, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        rows = result_rows(query.delete().eq("org_id", org_id).eq("alert_id", alert_id).execute())
        return bool(rows)

    def list_events(self, alert_ids: tuple[str, ...]) -> tuple[SpendAlertEventRecord, ...]:
        """Return fired events for a set of rules, newest first."""
        if not alert_ids:
            return ()
        rows = result_rows(
            self._client.table("gateway_spend_alert_events")
            .select(_EVENT_COLUMNS)
            .in_("alert_id", list(alert_ids))
            .order("fired_at", desc=True)
            .execute()
        )
        return tuple(SpendAlertEventRecord.model_validate(row) for row in rows)
