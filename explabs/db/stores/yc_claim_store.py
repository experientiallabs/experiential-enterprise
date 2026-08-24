# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""YC-company status and the launch grant, via the generalized `yc` org label.

"YC company" is no longer a bespoke ``yc_claims`` row: it is the presence of the
generalized ``yc`` label in ``public.org_labels`` (the same admin label system
every other org tag uses). The launch credit is a plain ``credit_ledger`` grant
(source ``yc_launch``) that carries its own expiry and spend snapshot, so the
generic ``process_expiring_grants`` pass claws back its unspent part at expiry.

Both the self-serve /yc funnel and the admin panel apply the label AND the grant
through one transactional function (``apply_yc_launch_grant``); the funnel uses
the launch defaults, the admin panel sets an explicit amount and expiry.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import (
    SupabaseClient,
    find_one_by_columns,
    first_row,
)

# The launch default when app_settings carries no override (most fixtures).
YC_GRANT_USD = 526.0

# The generalized org-label slug that marks a YC company.
YC_LABEL_KEY = "yc"


class LaunchGrantResult(BaseModel):
    """Outcome of applying the launch label + grant to one org."""

    model_config = ConfigDict(frozen=True)

    granted_usd: float
    expires_at: str
    balance_usd: float
    org_slug: str
    org_name: str
    # True when THIS call created the grant; False when the org already had it
    # (idempotent replay — no second grant or promo reversal was written).
    newly_applied: bool


class YcClaimStore:
    """YC-company status (the ``yc`` label) and the launch grant."""

    def __init__(self, client: SupabaseClient) -> None:
        """Wrap a service-role Supabase client (grant + expiry are definer)."""
        self._client = client

    def is_yc_company(self, org_id: str) -> bool:
        """Whether the org carries the ``yc`` label (the YC-company gate).

        Independent of grant expiry, so a YC org keeps its tool-account cards
        after the launch grant lapses — the label is the durable designation.
        """
        row = find_one_by_columns(
            self._client, "org_labels", {"org_id": org_id, "key": YC_LABEL_KEY}
        )
        return row is not None

    def apply_launch_grant(
        self,
        org_id: str,
        amount_usd: float,
        expires_at: str | None,
        created_by: str | None,
    ) -> LaunchGrantResult:
        """Mark the org a YC company and apply the launch grant.

        Applies the ``yc`` label, inserts the ``yc_launch`` grant (carrying its
        expiry + spend snapshot), and folds the $20 welcome promo in — all in one
        transaction. Idempotent per org: a replay applies neither a second grant
        nor a second reversal (``newly_applied`` is then False).

        Args:
            org_id: Organization receiving the grant + label.
            amount_usd: Grant size (the funnel passes the launch default; the
                admin panel passes an explicit amount).
            expires_at: ISO 8601 grant expiry, or None to let the grant default
                to now + 3 months (the funnel passes None; admin passes a date).
            created_by: The admin/user applying it, or None for the system.

        Returns:
            The grant outcome, including whether it was newly applied.
        """
        result = self._client.rpc(
            "apply_yc_launch_grant",
            {
                "in_org": org_id,
                "in_amount": amount_usd,
                "in_expires_at": expires_at,
                "in_created_by": created_by,
            },
        ).execute()
        row = first_row(result, context=f"YC launch grant for org {org_id}")
        return LaunchGrantResult.model_validate(row)

    def process_expiries(self) -> int:
        """Run one idempotent grant-expiry pass; returns grants processed."""
        result = self._client.rpc("process_expiring_grants", {}).execute()
        data: object = result.data
        if isinstance(data, bool) or not isinstance(data, int):
            msg = f"process_expiring_grants returned a non-integer payload: {data!r}"
            raise TypeError(msg)
        return data
