# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Provider account snapshots: credit/spend readings over time.

Each row is one reading of what a provider account could report at one
moment — month-to-date spend, credits remaining, usage limit — so the
Overview can show credits across accounts changing over time. Sources are
labeled honestly: a customer-declared figure is ``self_reported`` and never
masquerades as a provider read. Org members read snapshots under RLS; only
the service role writes them.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject, SupabaseClient, first_row, result_rows
from explabs.db.stores.provider_connection_store import ConnectableProvider


class SnapshotSource(StrEnum):
    """Where one snapshot's numbers came from."""

    # The provider's own account/billing API, read with the stored credential.
    PROVIDER_API = "provider_api"
    # Our-side cloud billing (AWS Cost Explorer), not a provider account API.
    OUR_SIDE = "our_side"
    # The customer told us; the declared-balance gauge writes these.
    SELF_REPORTED = "self_reported"


# The sources produced by actually querying a provider or cloud API. Only
# these gate the refresh staleness floors: a self-reported declare must never
# suppress a real read.
PROVIDER_READ_SOURCES = (SnapshotSource.PROVIDER_API, SnapshotSource.OUR_SIDE)


class ProviderAccountSnapshot(BaseModel):
    """Typed snapshot of one ``provider_account_snapshots`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    connection_id: str
    provider: ConnectableProvider
    taken_at: str
    spend_usd: float | None = None
    credits_remaining_usd: float | None = None
    usage_limit_usd: float | None = None
    source: SnapshotSource
    detail: JsonObject | None = None


_SNAPSHOT_COLUMNS = (
    "id, org_id, connection_id, provider, taken_at, "
    "spend_usd, credits_remaining_usd, usage_limit_usd, source, detail"
)


class ProviderSnapshotStore:
    """Persist and read provider account snapshots (service-role writes)."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client (service role for writes).
        """
        self._client = client

    def insert(
        self,
        *,
        org_id: str,
        connection_id: str,
        provider: ConnectableProvider,
        source: SnapshotSource,
        spend_usd: float | None = None,
        credits_remaining_usd: float | None = None,
        usage_limit_usd: float | None = None,
        detail: JsonObject | None = None,
    ) -> ProviderAccountSnapshot:
        """Record one reading.

        Args:
            org_id: Owning organization identifier.
            connection_id: The connection the reading is about.
            provider: The connection's provider (denormalized for org reads).
            source: Where the numbers came from.
            spend_usd: Month-to-date spend, when the source reports one.
            credits_remaining_usd: Remaining credit, when the source reports one.
            usage_limit_usd: Account/key usage limit, when the source reports one.
            detail: Non-secret extras (per-model breakdowns, raw figures).

        Returns:
            The stored snapshot.
        """
        result = (
            self._client.table("provider_account_snapshots")
            .insert(
                {
                    "org_id": org_id,
                    "connection_id": connection_id,
                    "provider": provider.value,
                    "taken_at": datetime.now(tz=UTC).isoformat(),
                    "spend_usd": spend_usd,
                    "credits_remaining_usd": credits_remaining_usd,
                    "usage_limit_usd": usage_limit_usd,
                    "source": source.value,
                    "detail": detail,
                }
            )
            .execute()
        )
        row = first_row(result, context=f"insert provider account snapshot for {connection_id}")
        return ProviderAccountSnapshot.model_validate(row)

    def latest_provider_read(self, connection_id: str) -> ProviderAccountSnapshot | None:
        """The newest snapshot a provider/cloud API produced for one connection.

        Self-reported snapshots are excluded on purpose: the staleness floor
        protects provider queries, and a manual declare must not suppress one.
        """
        result = (
            self._client.table("provider_account_snapshots")
            .select(_SNAPSHOT_COLUMNS)
            .eq("connection_id", connection_id)
            .in_("source", [source.value for source in PROVIDER_READ_SOURCES])
            .order("taken_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        return ProviderAccountSnapshot.model_validate(rows[0])
