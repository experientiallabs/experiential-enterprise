# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the imported historical-usage store."""

from __future__ import annotations

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.gateway_imported_usage_store import (
    GatewayImportedUsageStore,
    ImportedUsageWrite,
    ImportSource,
)

ORG = "11111111-1111-4111-8111-111111111111"
ORG_B = "33333333-3333-4333-8333-333333333333"
USER = "22222222-2222-4222-8222-222222222222"


def _write(record_hash: str, **overrides: object) -> ImportedUsageWrite:
    base: dict[str, object] = {
        "record_hash": record_hash,
        "source": ImportSource.CLAUDE_CODE,
        "raw_model": "claude-opus-4-8",
        "alias": "claude-opus-4-8",
        "provider": "anthropic",
        "model_matched": True,
        "input_tokens": 100,
        "output_tokens": 40,
        "cached_input_tokens": 10,
        "reasoning_tokens": 0,
        "estimated_cost_micro_usd": 1_500,
        "occurred_at": "2026-07-04T21:54:44+00:00",
        "day": "2026-07-04",
    }
    base.update(overrides)
    return ImportedUsageWrite.model_validate(base)


def test_reads_page_past_the_1000_row_cap() -> None:
    """Dedup must page all hashes; by_model must still sum every turn."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    total = 2_300  # > two PostgREST pages
    records = tuple(_write(f"{index:064x}") for index in range(total))
    first = store.record_batch(ORG, user_id=USER, batch_id="b1", records=records)
    assert first.inserted == total

    # The rollup sums every turn through one RPC, not a truncated page.
    rollups = store.by_model(ORG)
    assert sum(rollup.request_count for rollup in rollups) == total

    # Re-import: dedup must see ALL prior hashes (paged), so nothing re-inserts.
    again = store.record_batch(ORG, user_id=USER, batch_id="b2", records=records)
    assert again.inserted == 0
    assert again.duplicates == total


def test_by_model_uses_one_aggregation_rpc() -> None:
    """The Logs rollup is one RPC, not a paged full-row read."""
    client = FakeSupabaseClient()
    store = GatewayImportedUsageStore(client)
    store.record_batch(ORG, user_id=USER, batch_id="b1", records=(_write("h1"),))
    client.executed_rpcs.clear()
    rollups = store.by_model(ORG)
    assert client.executed_rpcs == ["gateway_imported_usage_by_model"]
    assert len(rollups) == 1


def test_record_batch_inserts_new_records() -> None:
    """A fresh batch inserts every record and reports zero duplicates."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    outcome = store.record_batch(
        ORG, user_id=USER, batch_id="b1", records=(_write("h1"), _write("h2"))
    )
    assert outcome.received == 2
    assert outcome.inserted == 2
    assert outcome.duplicates == 0


def test_record_batch_dedupes_across_batches() -> None:
    """Identity is (org, record_hash), so a NEW batch_id cannot double-count."""
    client = FakeSupabaseClient()
    store = GatewayImportedUsageStore(client)
    records = (_write("h1"), _write("h2"))
    store.record_batch(ORG, user_id=USER, batch_id="b1", records=records)
    # Same turns, different batch id (a retry) — must not insert again.
    replay = store.record_batch(ORG, user_id=USER, batch_id="b2", records=records)
    assert replay.inserted == 0
    assert replay.duplicates == 2
    assert len(client.tables["gateway_imported_usage_events"]) == 2


def test_reimport_overwrites_mapping_in_place() -> None:
    """A re-import of the same turn corrects its mapping without a second row."""
    client = FakeSupabaseClient()
    store = GatewayImportedUsageStore(client)
    # First import: model unknown, no attributed cost.
    store.record_batch(
        ORG,
        user_id=USER,
        batch_id="b1",
        records=(
            _write(
                "h1",
                raw_model="claude-opus-4-8-preview",
                alias=None,
                provider=None,
                model_matched=False,
                estimated_cost_micro_usd=0,
            ),
        ),
    )
    # Re-import same turn (same hash) after the catalog learns the model.
    store.record_batch(
        ORG,
        user_id=USER,
        batch_id="b2",
        records=(_write("h1", raw_model="claude-opus-4-8-preview"),),
    )
    assert len(client.tables["gateway_imported_usage_events"]) == 1
    rollups = store.by_model(ORG)
    assert len(rollups) == 1
    assert rollups[0].model_matched is True
    assert rollups[0].estimated_cost_micro_usd == 1_500


def test_record_batch_dedupes_within_the_batch() -> None:
    """A hash repeated inside one batch is written once."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    outcome = store.record_batch(
        ORG, user_id=USER, batch_id="b1", records=(_write("h1"), _write("h1"))
    )
    assert outcome.inserted == 1
    assert outcome.duplicates == 1


def test_by_model_aggregates_per_source_and_model() -> None:
    """Rollups sum tokens and cost per (source, model), spend first."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    store.record_batch(
        ORG,
        user_id=USER,
        batch_id="b1",
        records=(
            _write("h1", estimated_cost_micro_usd=1_000, input_tokens=100),
            _write("h2", estimated_cost_micro_usd=2_000, input_tokens=200),
            _write(
                "h3",
                source=ImportSource.CODEX,
                raw_model="gpt-5.6-sol",
                alias="gpt-5.6-sol",
                provider="openai",
                estimated_cost_micro_usd=500,
            ),
        ),
    )
    rollups = store.by_model(ORG)
    assert len(rollups) == 2
    # Claude Opus rows aggregate; highest spend first.
    top = rollups[0]
    assert top.model == "claude-opus-4-8"
    assert top.request_count == 2
    assert top.input_tokens == 300
    assert top.estimated_cost_micro_usd == 3_000
    assert rollups[1].model == "gpt-5.6-sol"
    assert rollups[1].source == ImportSource.CODEX


def test_by_model_keys_matched_alias_not_raw_model() -> None:
    """A matched turn groups on the catalog alias, not the raw log string."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    store.record_batch(
        ORG,
        user_id=USER,
        batch_id="b1",
        records=(
            _write(
                "h1",
                raw_model="claude-opus-4-8-preview",
                alias="claude-opus-4-8",
                model_matched=True,
                estimated_cost_micro_usd=1_500,
            ),
        ),
    )
    rollups = store.by_model(ORG)
    assert len(rollups) == 1
    assert rollups[0].model == "claude-opus-4-8"
    assert rollups[0].model_matched is True


def test_by_model_keys_unmatched_by_raw_model() -> None:
    """Unmatched models group by their raw string and stay flagged unmatched."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    store.record_batch(
        ORG,
        user_id=USER,
        batch_id="b1",
        records=(
            _write(
                "h1",
                source=ImportSource.CODEX,
                raw_model="o4-mini",
                alias=None,
                provider=None,
                model_matched=False,
                estimated_cost_micro_usd=0,
            ),
            _write(
                "h2",
                source=ImportSource.CODEX,
                raw_model="o4-mini",
                alias="should-be-ignored",
                provider=None,
                model_matched=False,
                estimated_cost_micro_usd=0,
            ),
        ),
    )
    rollups = store.by_model(ORG)
    assert len(rollups) == 1
    assert rollups[0].model == "o4-mini"
    assert rollups[0].model_matched is False
    assert rollups[0].request_count == 2
    assert rollups[0].estimated_cost_micro_usd == 0


def test_by_model_numeric_totals() -> None:
    """Token and cost columns sum across every turn in the group."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    store.record_batch(
        ORG,
        user_id=USER,
        batch_id="b1",
        records=(
            _write(
                "h1",
                input_tokens=10,
                output_tokens=4,
                cached_input_tokens=2,
                reasoning_tokens=1,
                estimated_cost_micro_usd=100,
            ),
            _write(
                "h2",
                input_tokens=20,
                output_tokens=6,
                cached_input_tokens=3,
                reasoning_tokens=2,
                estimated_cost_micro_usd=250,
            ),
        ),
    )
    [rollup] = store.by_model(ORG)
    assert rollup.request_count == 2
    assert rollup.input_tokens == 30
    assert rollup.output_tokens == 10
    assert rollup.cached_input_tokens == 5
    assert rollup.reasoning_tokens == 3
    assert rollup.estimated_cost_micro_usd == 350


def test_by_model_orders_by_cost_then_requests() -> None:
    """Equal spend ranks the group with more requests first; then source/model."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    store.record_batch(
        ORG,
        user_id=USER,
        batch_id="b1",
        records=(
            _write(
                "h1",
                source=ImportSource.CODEX,
                raw_model="gpt-5.6-sol",
                alias="gpt-5.6-sol",
                provider="openai",
                estimated_cost_micro_usd=1_000,
            ),
            _write("h2", estimated_cost_micro_usd=1_000),
            _write("h3", estimated_cost_micro_usd=1_000),
            _write(
                "h4",
                raw_model="claude-sonnet-4-6",
                alias="claude-sonnet-4-6",
                estimated_cost_micro_usd=3_000,
            ),
        ),
    )
    rollups = store.by_model(ORG)
    assert [rollup.model for rollup in rollups] == [
        "claude-sonnet-4-6",
        "claude-opus-4-8",
        "gpt-5.6-sol",
    ]
    assert rollups[1].request_count == 2
    assert rollups[2].request_count == 1


def test_by_model_is_tenant_scoped() -> None:
    """An org rollup never includes another org's imported turns."""
    store = GatewayImportedUsageStore(FakeSupabaseClient())
    store.record_batch(
        ORG,
        user_id=USER,
        batch_id="b1",
        records=(_write("h1", estimated_cost_micro_usd=1_000),),
    )
    store.record_batch(
        ORG_B,
        user_id=USER,
        batch_id="b2",
        records=(
            _write(
                "h2",
                raw_model="other-org-only",
                alias="other-org-only",
                estimated_cost_micro_usd=99_000,
            ),
        ),
    )
    rollups = store.by_model(ORG)
    assert len(rollups) == 1
    assert rollups[0].model == "claude-opus-4-8"
    assert rollups[0].estimated_cost_micro_usd == 1_000
    other = store.by_model(ORG_B)
    assert len(other) == 1
    assert other[0].model == "other-org-only"
