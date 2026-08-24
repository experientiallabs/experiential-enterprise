# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed access to the append-only ``credit_ledger``.

Credits-side entries only (grants, top-ups, adjustments); spend draws down
the balance through the organizations counters, never through ledger rows.
Inserts ride the service role (there are no authenticated write policies and
a trigger blocks mutation), so every write path — signup promo, admin grant,
Stripe webhook — leaves an auditable row.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject, SupabaseClient, first_row, result_rows
from explabs.db.stores.transitions import now_iso

ENTRY_TYPES = ("grant", "topup", "adjustment")
SOURCES = ("signup_promo", "migration", "admin", "stripe", "yc_launch")


class CreditLedgerEntry(BaseModel):
    """Typed snapshot of one ``credit_ledger`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    entry_type: str
    amount_usd: float
    reason: str | None = None
    source: str
    source_ref: str | None = None
    created_by: str | None = None
    created_at: str

    def api_view(self) -> JsonObject:
        """The member-facing projection.

        ``source_ref`` (an external idempotency handle, e.g. a Stripe session
        id) and ``created_by`` stay server-side; members see what happened,
        when, and why.
        """
        return {
            "id": self.id,
            "entry_type": self.entry_type,
            "amount_usd": self.amount_usd,
            "reason": self.reason,
            "source": self.source,
            "created_at": self.created_at,
        }


class CreditLedgerStore:
    """Reads and appends over ``credit_ledger``."""

    def __init__(self, client: SupabaseClient) -> None:
        """Wrap a Supabase client.

        Args:
            client: Service-role client for writes; either role for reads
                (members read their org's rows through RLS).
        """
        self._client = client

    def list_for_org(self, org_id: str, *, limit: int = 50) -> list[CreditLedgerEntry]:
        """Return an org's ledger entries, newest first.

        Args:
            org_id: Organization identifier.
            limit: Maximum entries returned (clamped to [1, 200]).
        """
        bounded = max(1, min(limit, 200))
        result = (
            self._client.table("credit_ledger")
            .select("*")
            .eq("org_id", org_id)
            .order("created_at", desc=True)
            .limit(bounded)
            .execute()
        )
        return [CreditLedgerEntry.model_validate(row) for row in result_rows(result)]

    def insert(
        self,
        *,
        org_id: str,
        entry_type: str,
        amount_usd: float,
        source: str,
        reason: str | None = None,
        source_ref: str | None = None,
        created_by: str | None = None,
    ) -> CreditLedgerEntry:
        """Append one ledger entry and return it.

        Args:
            org_id: Organization credited (or debited, for adjustments).
            entry_type: One of ``grant``, ``topup``, ``adjustment``.
            amount_usd: Signed amount; only adjustments may be negative.
            source: One of the ledger's source vocabulary.
            reason: Human-readable line for the history view.
            source_ref: External idempotency handle (unique per source).
            created_by: Acting user id, when there is one.

        Raises:
            ValueError: On a vocabulary violation, before touching the
                database (the check constraints would refuse anyway; failing
                here keeps the error typed and readable).
        """
        if entry_type not in ENTRY_TYPES:
            msg = f"unknown credit ledger entry_type: {entry_type!r}"
            raise ValueError(msg)
        if source not in SOURCES:
            msg = f"unknown credit ledger source: {source!r}"
            raise ValueError(msg)
        if amount_usd == 0:
            msg = "credit ledger entries must carry a non-zero amount"
            raise ValueError(msg)
        if amount_usd < 0 and entry_type != "adjustment":
            msg = "only adjustments may be negative"
            raise ValueError(msg)
        payload: JsonObject = {
            "org_id": org_id,
            "entry_type": entry_type,
            "amount_usd": amount_usd,
            "reason": reason,
            "source": source,
            "source_ref": source_ref,
            "created_by": created_by,
            "created_at": now_iso(),
        }
        result = self._client.table("credit_ledger").insert(payload).execute()
        row = first_row(result, context=f"credit ledger insert for org {org_id}")
        return CreditLedgerEntry.model_validate(row)
