# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The scheduled balance-fetch runner: refresh every connected account nightly.

A single pass over every org's provider connections and tool accounts, so
``/credits`` reflects fresh balances without a user clicking "Fetch balance".
It reuses the on-demand seams exactly:

- Provider connections go through ``read_spend`` and, on a ``REPORTED`` read,
  persist a ``provider_account_snapshots`` row (the same write the on-demand
  refresh does). Per-provider staleness floors are honored so the nightly pass
  never re-bills a floored provider (Bedrock's Cost Explorer costs $0.01/query),
  and the never-reportable providers (Azure, Gemini) are skipped — their
  computer-use balance read is not yet enabled.
- Tool accounts go through the pluggable balance fetcher (deterministic where a
  vendor billing API exists — Cursor — otherwise the stubbed computer-use path)
  and update the account's tracked balance in place.

The runner is management-plane only and releases each credential just for its
one read, never returning or logging key material. Its seams (``spend_reader``,
``tool_fetcher_factory``) are injectable so tests can drive a deterministic read
without a live provider.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.provider_connection_store import (
    ConnectableProvider,
    ProviderConnectionRecord,
    ProviderConnectionStore,
)
from explabs.db.stores.provider_snapshot_store import (
    ProviderAccountSnapshot,
    ProviderSnapshotStore,
)
from explabs.db.stores.tool_account_store import (
    FetchStatus,
    ToolAccountRecord,
    ToolAccountStore,
)
from explabs.providers.balance_fetch import (
    TOOL_VENDOR_STRATEGY,
    BalanceFetcher,
    BalanceFetchKind,
    BalanceFetchStrategy,
    build_tool_fetcher,
)
from explabs.providers.spend import (
    SPEND_REFRESH_FLOOR_SECONDS,
    SpendReport,
    SpendReportKind,
    read_spend,
)

# The providers whose spend read needs the admin key rather than the main
# credential, and those never queried at all (nothing reportable to a data-plane
# key). Same split the on-demand refresh uses.
_ADMIN_KEY_SPEND_PROVIDERS = frozenset({ConnectableProvider.ANTHROPIC, ConnectableProvider.OPENAI})
_NEVER_REPORTABLE_PROVIDERS = frozenset(
    {ConnectableProvider.GEMINI, ConnectableProvider.AZURE_OPENAI}
)

SpendReader = Callable[..., SpendReport]
ToolFetcherFactory = Callable[..., BalanceFetcher]


class BalanceFetchRunSummary(BaseModel):
    """What one scheduled pass touched, for the route response and logging."""

    model_config = ConfigDict(frozen=True)

    providers_checked: int
    provider_snapshots_written: int
    providers_skipped_floor: int
    tool_accounts_checked: int
    tool_balances_updated: int
    errors: int


def run_scheduled_balance_fetch(
    client: SupabaseClient,
    *,
    now: datetime | None = None,
    spend_reader: SpendReader = read_spend,
    tool_fetcher_factory: ToolFetcherFactory = build_tool_fetcher,
) -> BalanceFetchRunSummary:
    """Refresh every connected account's balance in one pass.

    Args:
        client: Service-role Supabase client (writes snapshots and rows).
        now: The moment to floor against; defaults to now (test seam).
        spend_reader: The provider spend read; defaults to ``read_spend``.
        tool_fetcher_factory: Builds a tool-account fetcher; defaults to
            ``build_tool_fetcher``.

    Returns:
        A summary of what the pass touched.
    """
    moment = now if now is not None else datetime.now(tz=UTC)
    provider_store = ProviderConnectionStore(client)
    snapshot_store = ProviderSnapshotStore(client)
    tool_store = ToolAccountStore(client)

    providers_checked = 0
    snapshots_written = 0
    skipped_floor = 0
    tool_checked = 0
    tool_updated = 0
    errors = 0

    for record in provider_store.list_all():
        providers_checked += 1
        try:
            outcome = _refresh_provider(
                record, provider_store, snapshot_store, moment, spend_reader
            )
        except Exception:  # noqa: BLE001 - one bad account never sinks the pass
            errors += 1
            continue
        match outcome:
            case "written":
                snapshots_written += 1
            case "floored":
                skipped_floor += 1
            case _:
                pass

    for account in tool_store.list_all():
        tool_checked += 1
        try:
            if _refresh_tool_account(account, tool_store, tool_fetcher_factory):
                tool_updated += 1
        except Exception:  # noqa: BLE001 - one bad account never sinks the pass
            errors += 1
            continue

    return BalanceFetchRunSummary(
        providers_checked=providers_checked,
        provider_snapshots_written=snapshots_written,
        providers_skipped_floor=skipped_floor,
        tool_accounts_checked=tool_checked,
        tool_balances_updated=tool_updated,
        errors=errors,
    )


def _refresh_provider(
    record: ProviderConnectionRecord,
    provider_store: ProviderConnectionStore,
    snapshot_store: ProviderSnapshotStore,
    now: datetime,
    spend_reader: SpendReader,
) -> str:
    """Read one provider's spend and persist a snapshot; returns the outcome.

    Returns:
        ``"written"`` when a snapshot was persisted, ``"floored"`` when the
        staleness floor answered, ``"none"`` otherwise (nothing reportable or a
        failed read).
    """
    if record.provider in _NEVER_REPORTABLE_PROVIDERS:
        # Azure/Gemini expose nothing to a data-plane key; their computer-use
        # balance read is not yet enabled, so the scheduled pass skips them.
        return "none"

    floor_seconds = SPEND_REFRESH_FLOOR_SECONDS[record.provider]
    latest = snapshot_store.latest_provider_read(record.id)
    if latest is not None and now < _taken_at(latest) + timedelta(seconds=floor_seconds):
        return "floored"

    credential, spend_credential = _release_for_spend(provider_store, record)
    report = spend_reader(record, credential=credential, spend_credential=spend_credential)
    if report.kind is not SpendReportKind.REPORTED or report.source is None:
        return "none"
    snapshot_store.insert(
        org_id=record.org_id,
        connection_id=record.id,
        provider=record.provider,
        source=report.source,
        spend_usd=report.spend_usd,
        credits_remaining_usd=report.credits_remaining_usd,
        usage_limit_usd=report.usage_limit_usd,
        detail=report.detail,
    )
    return "written"


def _refresh_tool_account(
    account: ToolAccountRecord,
    tool_store: ToolAccountStore,
    tool_fetcher_factory: ToolFetcherFactory,
) -> bool:
    """Fetch one tool account's balance and record it; returns True if updated."""
    strategy = TOOL_VENDOR_STRATEGY[account.vendor]
    credential: str | None = None
    if strategy is BalanceFetchStrategy.DETERMINISTIC and account.credential_last4 is not None:
        credential = tool_store.release_credential(account.id)
    fetcher = tool_fetcher_factory(account.vendor, credential=credential, config=account.config)
    reading = fetcher.fetch()
    tool_store.record_fetch(
        org_id=account.org_id,
        vendor=account.vendor,
        status=FetchStatus(reading.kind.value),
        message=reading.message,
        balance_usd=reading.balance_usd,
        source=reading.source,
    )
    return reading.kind is BalanceFetchKind.REPORTED


def _release_for_spend(
    store: ProviderConnectionStore, record: ProviderConnectionRecord
) -> tuple[str | None, str | None]:
    """Release exactly the secret this provider's spend read needs."""
    if record.provider in _ADMIN_KEY_SPEND_PROVIDERS:
        if record.spend_credential_last4 is None:
            return None, None
        return None, store.release_spend_credential(record.id)
    return store.release_credential(record.id), None


def _taken_at(snapshot: ProviderAccountSnapshot) -> datetime:
    """A snapshot's ``taken_at`` as an aware datetime (naive parses as UTC)."""
    moment = datetime.fromisoformat(snapshot.taken_at)
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


def summary_payload(summary: BalanceFetchRunSummary) -> JsonObject:
    """The run summary as a plain JSON object for the route response."""
    return summary.model_dump()
