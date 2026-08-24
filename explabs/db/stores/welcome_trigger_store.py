# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The re-triggerable welcome celebration: per-org admin control.

The confetti + integration-prompt modal (the login success step) fires once for
a brand-new account. This store is the admin lever that RE-arms it: a platform
admin turns it on for an org (or a whole label cohort), choosing the credit
figure to announce and whether to surface the API key. Each activation bumps the
org's ``triggered_at`` so members who already saw it see it again on their next
workspace enter.

Two write lanes, one transactional function each:

* ``set_trigger`` → ``set_org_welcome_trigger`` for a single org (the admin
  panel's per-org "Welcome celebration" card).
* ``apply_by_label`` → ``apply_welcome_trigger_by_label`` for every org carrying
  a label (the cohort lane — "arm every ``yc`` org with $526").

Both are service-role definer functions; members only ever READ their own org's
trigger (RLS) from the web session.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import SupabaseClient, first_row


class WelcomeTrigger(BaseModel):
    """One org's welcome-celebration settings."""

    model_config = ConfigDict(frozen=True)

    org_id: str
    active: bool
    # The credit figure to ANNOUNCE, or None to fall back to the org's launch
    # grant amount at display time. Not a balance.
    display_credit_usd: float | None
    show_api_key: bool
    triggered_at: str


class WelcomeTriggerStore:
    """Admin writes to the per-org welcome-celebration trigger."""

    def __init__(self, client: SupabaseClient) -> None:
        """Wrap a service-role Supabase client (the write functions are definer)."""
        self._client = client

    def get_trigger(self, org_id: str) -> WelcomeTrigger | None:
        """Read one org's current welcome-trigger state, or None if never set.

        The admin detail page seeds its "Welcome celebration" card from this so
        it reflects the org's persisted state (armed/disarmed, amount, key flag)
        instead of fabricated defaults. Read through the service-role client: the
        table's only member-facing RLS policy scopes reads to the caller's own
        org, so a platform admin viewing another org must go through the backend.

        Args:
            org_id: Organization whose trigger to read.

        Returns:
            The org's trigger row, or None when it has never been armed.
        """
        result = (
            self._client.table("org_welcome_trigger")
            .select("org_id, active, display_credit_usd, show_api_key, triggered_at")
            .eq("org_id", org_id)
            .limit(1)
            .execute()
        )
        rows = result.data
        if not rows:
            return None
        return WelcomeTrigger.model_validate(rows[0])

    def set_trigger(
        self,
        org_id: str,
        active: bool,
        display_credit_usd: float | None,
        show_api_key: bool,
        updated_by: str | None,
    ) -> WelcomeTrigger:
        """Arm or disarm one org's welcome celebration.

        Activating bumps ``triggered_at`` so prior viewers see it again; a replay
        with ``active=False`` leaves ``triggered_at`` in place.

        Args:
            org_id: Organization whose trigger to write.
            active: Whether the celebration shows on members' next enter.
            display_credit_usd: The announced credit figure, or None to fall back
                to the org's launch grant at display time.
            show_api_key: Whether the modal surfaces the API key.
            updated_by: The admin applying it, or None for the system.

        Returns:
            The resulting trigger row.
        """
        result = self._client.rpc(
            "set_org_welcome_trigger",
            {
                "in_org": org_id,
                "in_active": active,
                "in_display_credit_usd": display_credit_usd,
                "in_show_api_key": show_api_key,
                "in_updated_by": updated_by,
            },
        ).execute()
        row = first_row(result, context=f"welcome trigger for org {org_id}")
        return WelcomeTrigger.model_validate(row)

    def apply_by_label(
        self,
        key: str,
        active: bool,
        display_credit_usd: float | None,
        show_api_key: bool,
        updated_by: str | None,
    ) -> int:
        """Apply the same trigger settings to every org carrying ``key``.

        Returns the number of orgs affected (the cohort size).
        """
        result = self._client.rpc(
            "apply_welcome_trigger_by_label",
            {
                "in_key": key,
                "in_active": active,
                "in_display_credit_usd": display_credit_usd,
                "in_show_api_key": show_api_key,
                "in_updated_by": updated_by,
            },
        ).execute()
        data: object = result.data
        if isinstance(data, bool) or not isinstance(data, int):
            msg = f"apply_welcome_trigger_by_label returned a non-integer payload: {data!r}"
            raise TypeError(msg)
        return data
