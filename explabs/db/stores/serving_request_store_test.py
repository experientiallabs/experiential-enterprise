# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the serving-request store."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import RepositoryError
from explabs.db.stores.serving_request_store import (
    ProjectServingBillingSource,
    ServingLeg,
    ServingRequestStore,
)

ORG_ID = "org-1"
OTHER_ORG_ID = "org-2"
ENDPOINT_A = "endpoint-a"
ENDPOINT_B = "endpoint-b"
MODEL_A = "internal-model-a"
MODEL_B = "internal-model-b"


def _store() -> tuple[ServingRequestStore, FakeSupabaseClient]:
    client = FakeSupabaseClient()
    return ServingRequestStore(client), client


def _request_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": "request-1",
        "org_id": ORG_ID,
        "endpoint_id": ENDPOINT_A,
        "endpoint_label": "support-triage",
        "model": "internal-model-a",
        "provider_model": "us.anthropic.claude-haiku-4-5-v1:0",
        "cluster_id": "cluster-0",
        "cluster_label": "billing-questions",
        "routing_reason": "cluster-0 routes to the cheapest model above the floor",
        "router_cost_usd": 0.0,
        "leg": "serving",
        "input_tokens": 1200,
        "output_tokens": 300,
        "cached_tokens": 0,
        "cost_usd": 0.003,
        "latency_ms": 310,
        "ttfb_ms": 90,
        "status": "ok",
        "error_message": None,
        "request": {"messages": [{"role": "user", "content": "hi"}]},
        "response": {"choices": [{"message": {"role": "assistant", "content": "hello"}}]},
        "created_at": "2026-07-22T10:00:00+00:00",
    }
    row.update(overrides)
    return row


def test_list_reads_newest_first_and_excludes_bodies_and_routing() -> None:
    """List rows come newest first without bodies or routing fields."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(id="request-old", created_at="2026-07-21T10:00:00+00:00"),
        _request_row(id="request-new", created_at="2026-07-22T10:00:00+00:00"),
        _request_row(id="request-elsewhere", org_id=OTHER_ORG_ID),
    ]
    items = store.list_requests(ORG_ID)
    assert [item.id for item in items] == ["request-new", "request-old"]
    dumped = items[0].model_dump()
    for hidden in (
        "model",
        "provider_model",
        "cluster_id",
        "cluster_label",
        "routing_reason",
        "router_cost_usd",
        "leg",
        "request",
        "response",
    ):
        assert hidden not in dumped


def test_list_filters_by_endpoint_status_and_window() -> None:
    """Endpoint, status, and time-window filters compose."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(id="request-match", status="error"),
        _request_row(id="request-ok"),
        _request_row(id="request-other-endpoint", endpoint_id=ENDPOINT_B, status="error"),
        _request_row(id="request-too-old", status="error", created_at="2026-07-01T00:00:00+00:00"),
    ]
    items = store.list_requests(
        ORG_ID,
        endpoint_id=ENDPOINT_A,
        status="error",
        after="2026-07-20T00:00:00+00:00",
    )
    assert [item.id for item in items] == ["request-match"]


def test_list_keyset_cursor_pages_without_overlap() -> None:
    """The (created_at, id) cursor returns strictly older rows."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(id=f"request-{index}", created_at=f"2026-07-2{index}T10:00:00+00:00")
        for index in range(3)
    ]
    first_page = store.list_requests(ORG_ID, limit=2)
    assert [item.id for item in first_page] == ["request-2", "request-1"]
    second_page = store.list_requests(
        ORG_ID,
        limit=2,
        cursor_ts=first_page[-1].created_at,
        cursor_id=first_page[-1].id,
    )
    assert [item.id for item in second_page] == ["request-0"]


def test_get_request_returns_full_row_and_raises_on_miss() -> None:
    """The detail fetch keeps bodies and routing fields; misses raise."""
    store, client = _store()
    client.tables["serving_requests"] = [_request_row()]
    record = store.get_request("request-1")
    assert record.request is not None
    assert record.model == "internal-model-a"
    assert record.provider_model == "us.anthropic.claude-haiku-4-5-v1:0"
    assert record.routing_reason == "cluster-0 routes to the cheapest model above the floor"
    # Free policy: a measured zero, distinct from the null that means unreported.
    assert record.router_cost_usd == 0.0
    assert record.leg is ServingLeg.SERVING
    with pytest.raises(RepositoryError):
        store.get_request("request-missing")


def test_get_request_reads_a_pre_audit_row_and_rejects_an_unknown_leg() -> None:
    """A row written before the audit columns reads as nulls, not as claims."""
    store, client = _store()
    # The shape the migration actually leaves behind: the three nullable
    # columns are null and `leg` is 'serving', because it landed NOT NULL with a
    # default. `leg` is therefore never absent from a real read, so this
    # asserts the null columns rather than an unreachable model default.
    client.tables["serving_requests"] = [
        _request_row(provider_model=None, routing_reason=None, router_cost_usd=None)
    ]
    record = store.get_request("request-1")
    assert record.provider_model is None
    assert record.routing_reason is None
    # Null because the row predates the column, which is not a $0 measurement.
    assert record.router_cost_usd is None
    assert record.leg is ServingLeg.SERVING

    # The leg vocabulary is closed at the typed boundary too, not only in the
    # database: an uncategorized leg must not travel on as a bare string.
    client.tables["serving_requests"] = [_request_row(leg="training")]
    with pytest.raises(ValidationError):
        store.get_request("request-1")


def test_stats_aggregates_counts_spend_tokens_and_percentiles() -> None:
    """Window stats cover counts, spend, token totals, and latency percentiles."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(id="request-a", latency_ms=100, cost_usd=0.01),
        _request_row(id="request-b", latency_ms=300, cost_usd=0.02, status="error"),
        _request_row(id="request-elsewhere", org_id=OTHER_ORG_ID, cost_usd=9.0),
    ]
    stats = store.stats(ORG_ID)
    assert stats.request_count == 2
    assert stats.error_count == 1
    assert stats.unpriced_count == 0
    assert stats.cost_usd_total == pytest.approx(0.03)
    assert stats.input_tokens_total == 2400
    assert stats.latency_p50_ms == pytest.approx(200.0)


def test_stats_empty_window_has_zero_counts_and_null_aggregates() -> None:
    """An empty window returns zero counts, not an error."""
    store, _ = _store()
    stats = store.stats(ORG_ID)
    assert stats.request_count == 0
    assert stats.unpriced_count == 0
    assert stats.cost_usd_total is None
    assert stats.latency_p50_ms is None


def test_buckets_group_by_epoch_floor_ascending() -> None:
    """Bucketed counts come back in ascending time order with error tallies."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(id="request-a", created_at="2026-07-21T10:00:00+00:00"),
        _request_row(id="request-b", created_at="2026-07-21T11:00:00+00:00", status="error"),
        _request_row(id="request-c", created_at="2026-07-22T10:00:00+00:00"),
    ]
    buckets = store.buckets(ORG_ID, bucket_seconds=86_400)
    assert [bucket.request_count for bucket in buckets] == [2, 1]
    assert buckets[0].error_count == 1


def test_endpoints_roll_up_most_recent_first() -> None:
    """The endpoint roll-up counts per endpoint and orders by recency."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(id="request-a"),
        _request_row(id="request-b", created_at="2026-07-22T11:00:00+00:00"),
        _request_row(
            id="request-c",
            endpoint_id=ENDPOINT_B,
            endpoint_label="code-review",
            created_at="2026-07-23T09:00:00+00:00",
        ),
    ]
    endpoints = store.endpoints(ORG_ID)
    assert [record.endpoint_id for record in endpoints] == [ENDPOINT_B, ENDPOINT_A]
    assert endpoints[1].request_count == 2


def test_endpoints_empty_when_org_never_served() -> None:
    """No serving traffic means an empty roll-up: the surface-gating signal."""
    store, client = _store()
    client.tables["serving_requests"] = [_request_row(org_id=OTHER_ORG_ID)]
    assert store.endpoints(ORG_ID) == ()


def test_insert_requests_truncates_oversized_bodies_instead_of_failing() -> None:
    """Bodies above the cap become a marker with a preview; the row survives."""
    store, client = _store()
    huge = {"messages": [{"role": "user", "content": "x" * 2_000_000}]}
    inserted = store.insert_requests([_request_row(request=huge)])
    assert inserted == 1
    stored = client.tables["serving_requests"][0]
    request_body = stored["request"]
    assert isinstance(request_body, dict)
    marker = {str(key): value for key, value in request_body.items()}
    assert marker["truncated"] is True
    original_bytes = marker["original_bytes"]
    assert isinstance(original_bytes, int)
    assert original_bytes > 2_000_000
    preview = marker["preview"]
    assert isinstance(preview, str)
    assert len(preview) <= 4_096
    response_body = stored["response"]
    assert isinstance(response_body, dict)
    assert "truncated" not in response_body


def test_insert_requests_ignores_id_conflicts() -> None:
    """Retried inserts converge instead of raising."""
    store, client = _store()
    inserted = store.insert_requests([_request_row()])
    assert inserted == 1
    again = store.insert_requests([_request_row()])
    assert again == 0
    assert len(client.tables["serving_requests"]) == 1


def test_list_filters_by_project() -> None:
    """The optimizer-Project filter narrows the list to one Project's traffic."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(id="request-p1", project_id="proj-1"),
        _request_row(id="request-p2", project_id="proj-2"),
        _request_row(id="request-none"),
    ]
    items = store.list_requests(ORG_ID, project_id="proj-1")
    assert [item.id for item in items] == ["request-p1"]


def test_get_request_carries_billing_and_byok_attribution() -> None:
    """The detail record keeps the payer split and the BYOK drawdown target."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(
            billing_source="mixed",
            billing_components={
                "router_embedding": "host_managed",
                "selected_candidate": "customer_managed",
            },
            byok=True,
            provider_connection_id="conn-1",
        )
    ]
    record = store.get_request("request-1")
    assert record.billing_source is ProjectServingBillingSource.MIXED
    assert record.billing_components is not None
    assert record.billing_components.selected_candidate == "customer_managed"
    assert record.byok is True
    # The provider connection id is a server-internal drawdown target: it rides
    # the admin/detail record but never the tenant list projection.
    assert record.provider_connection_id == "conn-1"


def test_endpoint_usage_splits_the_routed_model_mix() -> None:
    """The per-model roll-up keeps errors in token sums and unpriced a count."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(
            id="request-a1", model=MODEL_A, input_tokens=1000, output_tokens=200, cost_usd=0.01
        ),
        _request_row(
            id="request-a2",
            model=MODEL_A,
            status="error",
            input_tokens=500,
            output_tokens=0,
            cost_usd=0.02,
        ),
        _request_row(
            id="request-a3", model=MODEL_A, input_tokens=300, output_tokens=100, cost_usd=0.005
        ),
        _request_row(
            id="request-b1", model=MODEL_B, input_tokens=100, output_tokens=50, cost_usd=None
        ),
        _request_row(id="request-other-endpoint", endpoint_id=ENDPOINT_B, model=MODEL_A),
        _request_row(id="request-elsewhere", org_id=OTHER_ORG_ID, model=MODEL_A),
    ]
    rows = store.endpoint_usage(ORG_ID, ENDPOINT_A)
    assert [row.model for row in rows] == [MODEL_A, MODEL_B]
    model_a = rows[0]
    assert model_a.request_count == 2
    assert model_a.error_count == 1
    # The errored call's tokens still count; only its success tally does not.
    assert model_a.input_tokens == 1800
    assert model_a.cost_usd == pytest.approx(0.035)
    assert model_a.unpriced_count == 0
    model_b = rows[1]
    assert model_b.request_count == 1
    assert model_b.unpriced_count == 1
    assert model_b.cost_usd == 0.0


def test_usage_timeseries_buckets_by_model_time_and_zero_cost() -> None:
    """(model, day) cells split zero-cost tokens and honor the ``after`` bound."""
    store, client = _store()
    client.tables["serving_requests"] = [
        _request_row(
            id="request-day1-priced",
            input_tokens=1000,
            output_tokens=200,
            cost_usd=0.01,
            created_at="2026-07-21T10:00:00+00:00",
        ),
        _request_row(
            id="request-day1-free",
            input_tokens=500,
            output_tokens=100,
            cached_tokens=10,
            cost_usd=0.0,
            created_at="2026-07-21T15:00:00+00:00",
        ),
        _request_row(
            id="request-day2",
            input_tokens=300,
            output_tokens=50,
            cost_usd=0.02,
            created_at="2026-07-22T10:00:00+00:00",
        ),
        _request_row(
            id="request-too-old",
            cost_usd=0.09,
            created_at="2026-07-01T00:00:00+00:00",
        ),
    ]
    cells = store.usage_timeseries(
        ORG_ID,
        ENDPOINT_A,
        after="2026-07-20T00:00:00+00:00",
        bucket_seconds=86_400,
    )
    assert [cell.bucket_start for cell in cells] == [
        "2026-07-21T00:00:00+00:00",
        "2026-07-22T00:00:00+00:00",
    ]
    day_one = cells[0]
    assert day_one.model == MODEL_A
    assert day_one.request_count == 2
    assert day_one.input_tokens == 1500
    # The real $0 row adds nothing to spend but its tokens stay excludable from
    # the frontier baseline via the zero-cost sums.
    assert day_one.cost_usd == pytest.approx(0.01)
    assert day_one.zero_cost_input_tokens == 500
    assert day_one.zero_cost_output_tokens == 100
    assert cells[1].cost_usd == pytest.approx(0.02)
