# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the tenant usage routes over the gateway usage store."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import ORG_ID, OTHER_ORG_ID, USER_ID
from explabs.api.routes.gateway_usage import _WINDOW_QUANTUM_SECONDS, _WINDOWS, _window
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.gateway_usage_store import _aggregation_cache

KEY_PROD = "bbbb0000-0000-4000-8000-000000000001"
KEY_CLI = "bbbb0000-0000-4000-8000-000000000002"
KEY_DELETED = "bbbb0000-0000-4000-8000-000000000003"


@pytest.fixture(autouse=True)
def _reset_aggregation_cache() -> None:
    """Isolate the store's process-wide aggregate cache between tests.

    The window bound is quantized, so two tests inside the same quantum share
    a cache key and would otherwise read each other's seeded aggregates.
    """
    _aggregation_cache.clear()


def _iso(hours_ago: float) -> str:
    return (datetime.now(tz=UTC) - timedelta(hours=hours_ago)).isoformat()


def _event_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "request_id": "req-1",
        "org_id": ORG_ID,
        "api_key_id": KEY_PROD,
        "user_id": None,
        "alias": "haiku",
        "provider": "anthropic",
        "lane": "platform_funded",
        "input_tokens": 100,
        "output_tokens": 20,
        "cached_input_tokens": 0,
        "reasoning_tokens": 0,
        "cost_micro_usd": 3_000,
        "estimated_cost_micro_usd": 0,
        "pricing_known": True,
        "latency_ms": 400,
        "status": "completed",
        "attempt_count": 1,
        "day": "2026-08-19",
        "created_at": _iso(1),
        "failure_class": None,
        "error_message": None,
    }
    row.update(overrides)
    return row


def _seed(supabase: FakeSupabaseClient) -> None:
    supabase.tables["api_keys"].extend(
        [
            {"id": KEY_PROD, "org_id": ORG_ID, "name": "prod-agent"},
            {"id": KEY_CLI, "org_id": ORG_ID, "name": "cli"},
        ]
    )
    supabase.tables["gateway_usage_events"] = [
        _event_row(request_id="req-1", tools_used=["search", "fetch"]),
        _event_row(
            request_id="req-2",
            status="failed",
            input_tokens=50,
            output_tokens=0,
            cost_micro_usd=0,
            attempt_count=2,
            created_at=_iso(2),
            failure_class="provider_internal",
            error_message="Anthropic returned a 529 overloaded error.",
        ),
        # Pure BYOK request: nothing charged, everything estimated.
        _event_row(
            request_id="req-3",
            api_key_id=KEY_CLI,
            alias="sonnet",
            provider="openai",
            lane="pass_through",
            cost_micro_usd=0,
            estimated_cost_micro_usd=9_000,
            created_at=_iso(3),
        ),
        _event_row(
            request_id="req-4",
            api_key_id=KEY_DELETED,
            created_at=_iso(4),
        ),
        _event_row(request_id="req-old", created_at=_iso(24 * 20)),
        _event_row(request_id="req-elsewhere", org_id=OTHER_ORG_ID),
    ]


def test_window_bound_is_quantized_so_polls_share_a_cache_key() -> None:
    """Every window's lower bound lands on a quantum, not on the call instant.

    The store caches aggregates keyed on this bound; a per-call microsecond
    value made every ~5s dashboard poll a guaranteed miss.
    """
    bounds = {key: datetime.fromisoformat(_window(key)[1]) for key in _WINDOWS}
    now = datetime.now(tz=UTC)
    for key, bound in bounds.items():
        lookback, _ = _WINDOWS[key]
        assert int(bound.timestamp()) % _WINDOW_QUANTUM_SECONDS == 0
        # Flooring only ever moves the bound back, and by under one quantum.
        drift = (now - lookback) - bound
        assert timedelta(0) <= drift < timedelta(seconds=2 * _WINDOW_QUANTUM_SECONDS)


def test_timeseries_exposes_model_and_api_lane_vocabulary(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Buckets carry the model slug and platform/byok lanes with dollar costs."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/usage/timeseries", params={"window": "7d"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["window"] == "7d"
    assert payload["bucket_seconds"] == 86_400
    lanes = {(bucket["model"], bucket["lane"]) for bucket in payload["buckets"]}
    assert ("haiku", "platform") in lanes
    assert ("sonnet", "byok") in lanes
    assert {"pass_through", "platform_funded"}.isdisjoint(
        bucket["lane"] for bucket in payload["buckets"]
    )
    sonnet = next(bucket for bucket in payload["buckets"] if bucket["model"] == "sonnet")
    # Money keeps the ledger split: charged vs never-charged estimate.
    assert sonnet["cost_usd"] == 0.0
    assert sonnet["estimated_cost_usd"] == 0.009
    assert sonnet["request_count"] == 1
    haiku_platform = next(
        bucket
        for bucket in payload["buckets"]
        if bucket["model"] == "haiku" and bucket["lane"] == "platform"
    )
    assert haiku_platform["estimated_cost_usd"] == 0.0
    window_total = sum(bucket["request_count"] for bucket in payload["buckets"])
    assert window_total == 4  # req-old (20 days back) and the other org are out


def test_timeseries_filters_compose_and_validate(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Model, key, and lane filters narrow; bad filter values are 400s."""
    _seed(supabase)
    base = f"/api/orgs/{ORG_ID}/usage/timeseries"
    byok = api.get(base, params={"lane": "byok"}).json()
    assert {bucket["model"] for bucket in byok["buckets"]} == {"sonnet"}
    keyed = api.get(base, params={"api_key_id": KEY_CLI}).json()
    assert {bucket["model"] for bucket in keyed["buckets"]} == {"sonnet"}
    modeled = api.get(base, params={"model": "haiku"}).json()
    assert {bucket["model"] for bucket in modeled["buckets"]} == {"haiku"}
    assert api.get(base, params={"lane": "pass_through"}).status_code == 400
    assert api.get(base, params={"api_key_id": "not-a-uuid"}).status_code == 400
    assert api.get(base, params={"window": "90d"}).status_code == 400


def test_by_key_groups_models_with_totals_and_deleted_key_label(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """One row per key with per-model splits, totals, and a null deleted label."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/usage/by-key")
    assert response.status_code == 200
    keys = {row["api_key_id"]: row for row in response.json()["keys"]}
    assert set(keys) == {KEY_PROD, KEY_CLI, KEY_DELETED}
    prod = keys[KEY_PROD]
    assert prod["key_label"] == "prod-agent"
    assert prod["totals"]["request_count"] == 2
    assert prod["totals"]["error_count"] == 1
    assert prod["totals"]["cost_usd"] == 0.003
    assert prod["totals"]["estimated_cost_usd"] == 0.0
    assert [entry["model"] for entry in prod["models"]] == ["haiku"]
    cli = keys[KEY_CLI]
    assert cli["models"][0]["model"] == "sonnet"
    assert cli["totals"]["cost_usd"] == 0.0
    assert cli["totals"]["estimated_cost_usd"] == 0.009
    assert keys[KEY_DELETED]["key_label"] is None
    # Highest ALL-spend (charged + estimated) first: the pure-BYOK key leads.
    assert next(iter(response.json()["keys"]))["api_key_id"] == KEY_CLI


def test_by_provider_rolls_up_platforms_with_the_money_split(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """One row per provider, ordered by all-spend, split money intact."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/usage/by-provider")
    assert response.status_code == 200
    payload = response.json()
    assert payload["window"] == "7d"
    providers = {row["provider"]: row for row in payload["providers"]}
    assert set(providers) == {"anthropic", "openai"}
    anthropic = providers["anthropic"]
    # req-1, req-2, req-4 (req-old falls outside the 7d window).
    assert anthropic["request_count"] == 3
    assert anthropic["error_count"] == 1
    assert anthropic["cost_usd"] == 0.006
    assert anthropic["estimated_cost_usd"] == 0.0
    openai = providers["openai"]
    assert openai["cost_usd"] == 0.0
    assert openai["estimated_cost_usd"] == 0.009
    # Highest ALL-spend (charged + estimated) first: the BYOK provider leads.
    assert payload["providers"][0]["provider"] == "openai"
    # The other org's traffic never surfaces.
    assert all(row["request_count"] < 4 for row in payload["providers"])


def test_by_provider_groups_undispatched_requests_under_null(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A request that never reached a provider surfaces as the null group."""
    _seed(supabase)
    supabase.tables["gateway_usage_events"].append(
        _event_row(
            request_id="req-undispatched",
            provider=None,
            lane=None,
            status="failed",
            input_tokens=0,
            output_tokens=0,
            cost_micro_usd=0,
            attempt_count=0,
            created_at=_iso(5),
        )
    )
    response = api.get(f"/api/orgs/{ORG_ID}/usage/by-provider")
    assert response.status_code == 200
    null_rows = [row for row in response.json()["providers"] if row["provider"] is None]
    assert len(null_rows) == 1
    assert null_rows[0]["request_count"] == 1
    assert null_rows[0]["error_count"] == 1


def test_requests_list_is_the_complete_content_free_record(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Rows carry model, provider, lane, key attribution, and attempt count."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/usage/requests")
    assert response.status_code == 200
    rows = {row["request_id"]: row for row in response.json()["requests"]}
    assert set(rows) == {"req-1", "req-2", "req-3", "req-4"}
    failed = rows["req-2"]
    assert failed["model"] == "haiku"
    assert failed["provider"] == "anthropic"
    assert failed["lane"] == "platform"
    assert failed["key_label"] == "prod-agent"
    assert failed["status"] == "failed"
    assert failed["attempt_count"] == 2
    assert failed["cost_usd"] == 0.0
    assert failed["estimated_cost_usd"] == 0.0
    byok_row = rows["req-3"]
    assert byok_row["cost_usd"] == 0.0
    assert byok_row["estimated_cost_usd"] == 0.009
    # Content-free ledger: no stored bodies ride along, ever.
    assert {"request", "response"}.isdisjoint(failed)
    assert rows["req-4"]["key_label"] is None
    # Tool names ride along as names only; a request with none captured reads
    # as the empty list (the honest empty state, the current state everywhere).
    assert rows["req-1"]["tools_used"] == ["search", "fetch"]
    assert failed["tools_used"] == []
    # Max content-free metadata: the full token breakdown rides each row.
    assert "cached_input_tokens" in rows["req-1"]
    assert "reasoning_tokens" in rows["req-1"]
    # A non-OK row carries WHY it ended (names/reasons only, never content).
    assert failed["failure_class"] == "provider_internal"
    assert failed["error_message"] == "Anthropic returned a 529 overloaded error."
    # A completed row has no failure reason — the status IS the outcome.
    assert rows["req-1"]["failure_class"] is None
    assert rows["req-1"]["error_message"] is None


def test_requests_list_exposes_the_real_per_call_cost(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Every row carries the always-real cost, at full sub-cent precision."""
    _seed(supabase)
    rows = {
        row["request_id"]: row
        for row in api.get(f"/api/orgs/{ORG_ID}/usage/requests").json()["requests"]
    }
    # Platform-funded: real cost is the charged amount, kept to micro-USD.
    platform = rows["req-1"]
    assert platform["cost_usd"] == 0.003
    assert platform["real_cost_usd"] == 0.003
    assert platform["pricing_known"] is True
    # BYOK: nothing charged, but the real cost is the never-charged estimate,
    # so the call never reads as free.
    byok = rows["req-3"]
    assert byok["cost_usd"] == 0.0
    assert byok["estimated_cost_usd"] == 0.009
    assert byok["real_cost_usd"] == 0.009


def test_requests_list_marks_an_unpriced_request(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A dispatched-but-unpriced request reads as unpriced, not free $0.00."""
    supabase.tables["api_keys"].append({"id": KEY_PROD, "org_id": ORG_ID, "name": "prod-agent"})
    supabase.tables["gateway_usage_events"] = [
        _event_row(
            request_id="req-unpriced",
            output_tokens=1_013,
            cost_micro_usd=0,
            estimated_cost_micro_usd=0,
            pricing_known=False,
        ),
    ]
    row = api.get(f"/api/orgs/{ORG_ID}/usage/requests").json()["requests"][0]
    assert row["real_cost_usd"] == 0.0
    assert row["pricing_known"] is False


def test_requests_list_filters_paginates_and_validates(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Status/lane filters narrow; full pages cursor; bad params are 400s."""
    _seed(supabase)
    base = f"/api/orgs/{ORG_ID}/usage/requests"
    errors = api.get(base, params={"status": "error"}).json()
    assert [row["request_id"] for row in errors["requests"]] == ["req-2"]

    first = api.get(base, params={"limit": 2}).json()
    assert [row["request_id"] for row in first["requests"]] == ["req-1", "req-2"]
    cursor = first["next_cursor"]
    assert cursor is not None
    second = api.get(
        base,
        params={
            "limit": 2,
            "cursor_ts": cursor["ts"],
            "cursor_id": cursor["id"],
            "cursor_after": cursor["after"],
        },
    ).json()
    assert [row["request_id"] for row in second["requests"]] == ["req-3", "req-4"]

    assert api.get(base, params={"status": "ok"}).status_code == 400
    assert api.get(base, params={"lane": "platform_funded"}).status_code == 400
    assert api.get(base, params={"cursor_ts": _iso(1)}).status_code == 400
    assert api.get(base, params={"api_key_id": "not-a-uuid"}).status_code == 400


def test_telemetry_settings_default_off_and_admin_toggles(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Content capture is off by default; an org admin can turn it on."""
    _seed(supabase)
    base = f"/api/orgs/{ORG_ID}/telemetry-settings"
    assert api.get(base).json() == {"capture_prompt_content": False}
    put = api.put(base, json={"capture_prompt_content": True})
    assert put.status_code == 200
    assert put.json() == {"capture_prompt_content": True}
    assert api.get(base).json() == {"capture_prompt_content": True}


def test_telemetry_settings_write_is_admin_only(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A non-admin member cannot change the content-capture opt-in."""
    _seed(supabase)
    base = f"/api/orgs/{ORG_ID}/telemetry-settings"
    # A plain member may read the setting.
    viewer = {"X-Explabs-Actor-Id": USER_ID}
    assert api.get(base, headers=viewer).status_code == 200
    # But not write it — the admin gate forbids a non-admin member.
    denied = api.put(base, json={"capture_prompt_content": True}, headers=viewer)
    assert denied.status_code == 403
    assert api.get(base, headers=viewer).json() == {"capture_prompt_content": False}


def test_suggestions_fire_for_a_seeded_org_with_skewed_usage(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Sustained small requests on a pricey model yield a real suggestion."""
    _seed(supabase)
    # 30 small requests to Claude Fable 5: $0.01 each at its list prices.
    supabase.tables["gateway_usage_events"].extend(
        _event_row(
            request_id=f"req-fable-{index}",
            alias="claude-fable-5",
            input_tokens=500,
            output_tokens=100,
            cost_micro_usd=10_000,
            created_at=_iso(5 + index * 0.1),
        )
        for index in range(30)
    )
    response = api.get(f"/api/orgs/{ORG_ID}/suggestions", params={"window": "7d"})
    assert response.status_code == 200
    suggestions = response.json()["suggestions"]
    assert len(suggestions) >= 1
    lead = suggestions[0]
    # The exact documented contract shape, field for field.
    assert set(lead) == {
        "id",
        "kind",
        "title",
        "body",
        "estimated_monthly_savings_usd",
        "evidence",
    }
    assert lead["kind"] == "cheaper_model"
    assert lead["id"] == "cheaper_model:claude-fable-5"
    assert lead["estimated_monthly_savings_usd"] is not None
    assert all(isinstance(line, str) and line for line in lead["evidence"])

    assert api.get(f"/api/orgs/{ORG_ID}/suggestions", params={"window": "90d"}).status_code == 400


def test_suggestions_stay_quiet_for_balanced_usage(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The base seed (a handful of requests) triggers no rule."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/suggestions")
    assert response.status_code == 200
    assert response.json() == {"suggestions": []}


def test_insights_query_answers_from_the_orgs_own_usage(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A plain-language question resolves to a ranked answer over real usage."""
    _seed(supabase)
    response = api.post(
        f"/api/orgs/{ORG_ID}/insights/query",
        json={"question": "which model cost me the most last week?"},
    )
    assert response.status_code == 200
    answer = response.json()
    assert answer["understood"] is True
    assert answer["metric"] == "spend"
    assert answer["dimension"] == "model"
    assert answer["window"] == "7d"
    assert answer["unit"] == "usd"
    # The pure-BYOK sonnet request ($0.009) outspends the haiku traffic.
    assert answer["rows"][0]["label"] == "sonnet"
    assert "sonnet" in answer["headline"]


def test_insights_query_by_provider_reads_the_request_log(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Provider-grouped answers come from the event sample and say so."""
    _seed(supabase)
    response = api.post(
        f"/api/orgs/{ORG_ID}/insights/query",
        json={"question": "show my error rate by provider"},
    )
    assert response.status_code == 200
    answer = response.json()
    assert answer["dimension"] == "provider"
    assert answer["unit"] == "percent"
    assert answer["caveat"] is not None
    providers = {row["label"] for row in answer["rows"]}
    assert {"anthropic", "openai"} <= providers


def test_insights_query_falls_back_when_it_cannot_parse(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An off-topic question returns an unmatched answer with examples."""
    _seed(supabase)
    response = api.post(
        f"/api/orgs/{ORG_ID}/insights/query",
        json={"question": "what is the weather in Paris?"},
    )
    assert response.status_code == 200
    answer = response.json()
    assert answer["understood"] is False
    assert answer["rows"] == []
    assert len(answer["examples"]) > 0


def test_usage_reads_are_org_scoped_and_membership_gated(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Another org's events never surface, and non-members get a 404."""
    _seed(supabase)
    for path in (
        "usage/timeseries",
        "usage/by-key",
        "usage/by-provider",
        "usage/requests",
        "suggestions",
    ):
        assert api.get(f"/api/orgs/{OTHER_ORG_ID}/{path}").status_code == 404
    # The insights query is gated by the same membership check.
    assert (
        api.post(
            f"/api/orgs/{OTHER_ORG_ID}/insights/query",
            json={"question": "how much did I spend?"},
        ).status_code
        == 404
    )

    member = api.get(
        f"/api/orgs/{ORG_ID}/usage/requests",
        headers={"X-Explabs-Actor-Id": USER_ID},
    )
    assert member.status_code == 200
    assert "req-elsewhere" not in {row["request_id"] for row in member.json()["requests"]}


# ---------------------------------------------------------------------------
# Deep Insights endpoints.


def _seed_insights(supabase: FakeSupabaseClient) -> None:
    """Two live keys and dispatched + pre-dispatch events with timing columns."""
    supabase.tables["api_keys"].extend(
        [
            {"id": KEY_PROD, "org_id": ORG_ID, "name": "prod-agent"},
            {"id": KEY_CLI, "org_id": ORG_ID, "name": "cli"},
        ]
    )
    supabase.tables["gateway_usage_events"] = [
        _event_row(
            request_id="ins-1",
            alias="haiku",
            provider="anthropic",
            input_tokens=100,
            output_tokens=200,
            cached_input_tokens=40,
            generation_duration_ms=2000,
            routing_overhead_ms=100,
            created_at=_iso(1),
        ),
        _event_row(
            request_id="ins-2",
            api_key_id=KEY_CLI,
            alias="sonnet",
            provider="openai",
            lane="pass_through",
            input_tokens=200,
            output_tokens=600,
            cached_input_tokens=100,
            cost_micro_usd=0,
            estimated_cost_micro_usd=9_000,
            generation_duration_ms=3000,
            routing_overhead_ms=200,
            created_at=_iso(2),
        ),
        # Pre-dispatch failure: no provider, no durations.
        _event_row(
            request_id="ins-3",
            api_key_id=KEY_CLI,
            alias="sonnet",
            provider=None,
            lane=None,
            input_tokens=0,
            output_tokens=0,
            status="expired_before_dispatch",
            attempt_count=0,
            cost_micro_usd=0,
            generation_duration_ms=None,
            routing_overhead_ms=None,
            latency_ms=None,
            created_at=_iso(3),
        ),
    ]


def test_insights_metrics_by_model(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The metrics endpoint groups by model with cache-hit and tok/s, in dollars."""
    _seed_insights(supabase)
    response = api.get(
        f"/api/orgs/{ORG_ID}/insights/metrics", params={"window": "7d", "group_by": "model"}
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["group_by"] == "model"
    cells = {cell["bucket_key"]: cell for cell in payload["cells"]}
    assert cells["haiku"]["cache_hit_rate"] == 40 / 100
    assert cells["haiku"]["tokens_per_second"] == 200 / 2
    sonnet = cells["sonnet"]
    assert sonnet["error_count"] == 1
    assert sonnet["tokens_per_second"] == 600 / 3
    assert sonnet["estimated_cost_usd"] == 0.009


def test_insights_metrics_rejects_unknown_group_by(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An unknown grouping dimension is a 400, not a silent empty result."""
    _seed_insights(supabase)
    assert (
        api.get(f"/api/orgs/{ORG_ID}/insights/metrics", params={"group_by": "region"}).status_code
        == 400
    )
    assert (
        api.get(f"/api/orgs/{ORG_ID}/insights/metrics", params={"window": "90d"}).status_code == 400
    )


def test_insights_metrics_requires_membership(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A non-member cannot read another org's insights."""
    _seed_insights(supabase)
    assert api.get(f"/api/orgs/{OTHER_ORG_ID}/insights/metrics").status_code == 404


def test_insights_tokens_per_second_series(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The tok/s endpoint returns one point per dispatched bucket."""
    _seed_insights(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/insights/tokens-per-second", params={"window": "24h"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["bucket_seconds"] == 3_600
    # Two dispatched requests, the pre-dispatch failure absent.
    assert sum(point["request_count"] for point in payload["points"]) == 2
    assert all(point["tokens_per_second"] is not None for point in payload["points"])
    only_sonnet = api.get(
        f"/api/orgs/{ORG_ID}/insights/tokens-per-second",
        params={"window": "24h", "provider": "openai"},
    ).json()
    assert len(only_sonnet["points"]) == 1


def test_insights_top_apps(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The top-apps endpoint ranks attribution keys with their labels."""
    _seed_insights(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/insights/top-apps", params={"window": "7d"})
    assert response.status_code == 200
    apps = {app["api_key_id"]: app for app in response.json()["apps"]}
    assert apps[KEY_PROD]["app_label"] == "prod-agent"
    assert apps[KEY_CLI]["request_count"] == 2
    assert apps[KEY_CLI]["cost_usd"] == 0.0
    assert apps[KEY_CLI]["estimated_cost_usd"] == 0.009
