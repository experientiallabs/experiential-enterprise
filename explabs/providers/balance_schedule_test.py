# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the scheduled balance-fetch runner across providers and tools."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.provider_connection_store import (
    ConnectableProvider,
    ProviderConnectionRecord,
    ProviderConnectionStore,
)
from explabs.db.stores.provider_snapshot_store import ProviderSnapshotStore, SnapshotSource
from explabs.db.stores.tool_account_store import (
    BalanceSource,
    FetchStatus,
    ToolAccountStore,
    TrackedToolVendor,
)
from explabs.providers.balance_fetch import (
    BalanceFetchKind,
    BalanceFetchStrategy,
    BalanceReading,
    ComputerUseBalanceFetcher,
    DeterministicBalanceFetcher,
)
from explabs.providers.balance_schedule import run_scheduled_balance_fetch
from explabs.providers.spend import SpendReport, SpendReportKind

ORG = "org-sched-1"


def _reported_spend(record: ProviderConnectionRecord, **_: object) -> SpendReport:
    """A deterministic provider read that always reports a remaining balance."""
    return SpendReport(
        kind=SpendReportKind.REPORTED,
        source=SnapshotSource.PROVIDER_API,
        credits_remaining_usd=50.0,
        message="mocked",
    )


def test_runner_persists_a_provider_snapshot_from_a_reported_read() -> None:
    """A REPORTED provider read writes a provider_account_snapshots row."""
    client = FakeSupabaseClient()
    ProviderConnectionStore(client).upsert(
        org_id=ORG, provider=ConnectableProvider.OPENROUTER, config={}, credential="or-key-abcdef"
    )
    summary = run_scheduled_balance_fetch(client, spend_reader=_reported_spend)
    assert summary.providers_checked == 1
    assert summary.provider_snapshots_written == 1
    snapshots = client.tables.get("provider_account_snapshots", [])
    assert len(snapshots) == 1
    assert snapshots[0]["credits_remaining_usd"] == 50.0
    assert snapshots[0]["source"] == SnapshotSource.PROVIDER_API.value


def test_runner_honors_the_staleness_floor() -> None:
    """A fresh provider read inside the floor is skipped, not re-queried."""
    client = FakeSupabaseClient()
    record = ProviderConnectionStore(client).upsert(
        org_id=ORG, provider=ConnectableProvider.OPENROUTER, config={}, credential="or-key-abcdef"
    )
    ProviderSnapshotStore(client).insert(
        org_id=ORG,
        connection_id=record.id,
        provider=ConnectableProvider.OPENROUTER,
        source=SnapshotSource.PROVIDER_API,
        credits_remaining_usd=10.0,
    )
    summary = run_scheduled_balance_fetch(client, spend_reader=_reported_spend)
    assert summary.providers_skipped_floor == 1
    assert summary.provider_snapshots_written == 0


def test_runner_invokes_the_computer_use_path_for_an_api_less_tool_account() -> None:
    """An E2B account gets the stubbed computer-use read (a PENDING record)."""
    client = FakeSupabaseClient()
    store = ToolAccountStore(client)
    store.set_declared_balance(org_id=ORG, vendor=TrackedToolVendor.E2B, balance_usd=30.0)

    summary = run_scheduled_balance_fetch(client)
    assert summary.tool_accounts_checked == 1
    assert summary.tool_balances_updated == 0  # PENDING never overwrites the balance
    account = store.find(ORG, TrackedToolVendor.E2B)
    assert account is not None
    assert account.last_fetch_status is FetchStatus.PENDING
    assert account.declared_balance_usd == 30.0  # untouched by the stub


def test_runner_updates_a_deterministic_tool_balance_and_releases_only_its_credential() -> None:
    """A deterministic tool fetch overwrites the balance; the agent path does not."""
    client = FakeSupabaseClient()
    store = ToolAccountStore(client)
    store.set_credential(
        org_id=ORG, vendor=TrackedToolVendor.CURSOR, credential="cursor-admin-key-abcd"
    )
    store.ensure(org_id=ORG, vendor=TrackedToolVendor.E2B)
    seen: list[tuple[TrackedToolVendor, str | None]] = []

    def factory(vendor: TrackedToolVendor, *, credential: str | None, config: object):  # noqa: ANN202
        seen.append((vendor, credential))
        if vendor is TrackedToolVendor.CURSOR:
            return DeterministicBalanceFetcher(
                read=lambda: BalanceReading(
                    kind=BalanceFetchKind.REPORTED,
                    strategy=BalanceFetchStrategy.DETERMINISTIC,
                    balance_usd=77.0,
                    source=BalanceSource.VENDOR_API,
                    message="cursor mocked",
                )
            )
        return ComputerUseBalanceFetcher(
            vendor_label=vendor.value, dashboard_url="https://x", config={}, credential=None
        )

    summary = run_scheduled_balance_fetch(client, tool_fetcher_factory=factory)
    assert summary.tool_balances_updated == 1
    cursor = store.find(ORG, TrackedToolVendor.CURSOR)
    assert cursor is not None
    assert cursor.declared_balance_usd == 77.0
    assert cursor.balance_source is BalanceSource.VENDOR_API
    # Cursor (deterministic, has a credential) gets the released key; E2B (agent)
    # gets None, so no dashboard secret leaves Vault on the stubbed path.
    assert (TrackedToolVendor.CURSOR, "cursor-admin-key-abcd") in seen
    assert (TrackedToolVendor.E2B, None) in seen


def test_runner_skips_never_reportable_providers() -> None:
    """Azure/Gemini expose nothing to a data-plane key; the pass skips them."""
    client = FakeSupabaseClient()
    ProviderConnectionStore(client).upsert(
        org_id=ORG, provider=ConnectableProvider.GEMINI, config={}, credential="gm-key-abcdef"
    )

    def _boom(record: ProviderConnectionRecord, **_: object) -> SpendReport:
        msg = "never-reportable providers must not be queried"
        raise AssertionError(msg)

    summary = run_scheduled_balance_fetch(client, spend_reader=_boom, now=datetime.now(tz=UTC))
    assert summary.providers_checked == 1
    assert summary.provider_snapshots_written == 0


def test_taken_at_parses_naive_timestamps_as_utc() -> None:
    """A floor comparison tolerates a naive stored timestamp."""
    client = FakeSupabaseClient()
    record = ProviderConnectionStore(client).upsert(
        org_id=ORG, provider=ConnectableProvider.OPENROUTER, config={}, credential="or-key-abcdef"
    )
    ProviderSnapshotStore(client).insert(
        org_id=ORG,
        connection_id=record.id,
        provider=ConnectableProvider.OPENROUTER,
        source=SnapshotSource.PROVIDER_API,
        credits_remaining_usd=10.0,
    )
    # Far in the future: the floor has lifted, so the read is taken again.
    summary = run_scheduled_balance_fetch(
        client, spend_reader=_reported_spend, now=datetime.now(tz=UTC) + timedelta(days=1)
    )
    assert summary.provider_snapshots_written == 1
