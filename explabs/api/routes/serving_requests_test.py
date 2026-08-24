# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the serving-request routes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from explabs.api.conftest import OPERATOR_ID, ORG_ID, OTHER_ORG_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient

ENDPOINT_A = "11111111-1111-1111-1111-111111111111"
ENDPOINT_B = "22222222-2222-2222-2222-222222222222"
PROJECT_ID = "33333333-3333-3333-3333-333333333333"

REQUEST_OK = "aaaa0000-0000-4000-8000-000000000001"
REQUEST_ERROR = "aaaa0000-0000-4000-8000-000000000002"
REQUEST_OLD = "aaaa0000-0000-4000-8000-000000000003"
REQUEST_OTHER_ORG = "aaaa0000-0000-4000-8000-000000000004"
REQUEST_B = "aaaa0000-0000-4000-8000-000000000005"
REQUEST_PROJECT_OK = "aaaa0000-0000-4000-8000-000000000006"
REQUEST_PROJECT_AMBIGUOUS = "aaaa0000-0000-4000-8000-000000000007"

_ADMIN = {"X-Explabs-Actor-Id": OPERATOR_ID}

# Every column that records HOW a call was routed. No tenant-facing read may
# serialize one; the operator audit serves all of them. `model` left this set
# with the gateway-launch reclassification ("we should not hide it for
# them"): WHICH model served is tenant data, WHY it was chosen is not.
_MECHANISM_KEYS = frozenset(
    {
        "provider_model",
        "cluster_id",
        "cluster_label",
        "routing_reason",
        "router_cost_usd",
        "leg",
    }
)


def _iso(hours_ago: float) -> str:
    return (datetime.now(tz=UTC) - timedelta(hours=hours_ago)).isoformat()


def _request_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": REQUEST_OK,
        "org_id": ORG_ID,
        "endpoint_id": ENDPOINT_A,
        "endpoint_label": "support-triage",
        "model": "internal-model-a",
        "provider_model": "us.anthropic.claude-haiku-4-5-v1:0",
        "cluster_id": "cluster-0",
        "cluster_label": "billing-questions",
        "routing_reason": "cluster-0 routes to the cheapest model above the quality floor",
        "router_cost_usd": 0.0,
        "leg": "serving",
        "input_tokens": 1_000_000,
        "output_tokens": 0,
        "cached_tokens": 0,
        "cost_usd": 0.003,
        "latency_ms": 310,
        "ttfb_ms": 90,
        "status": "ok",
        "error_message": None,
        "request": {"messages": [{"role": "user", "content": "hi"}]},
        "response": {"choices": [{"message": {"role": "assistant", "content": "hello"}}]},
        "created_at": _iso(1),
    }
    row.update(overrides)
    return row


def _seed(supabase: FakeSupabaseClient) -> None:
    supabase.tables["serving_requests"] = [
        _request_row(),
        _request_row(id=REQUEST_ERROR, status="error", error_message="upstream 500"),
        _request_row(id=REQUEST_OLD, created_at=_iso(30)),
        _request_row(id=REQUEST_OTHER_ORG, org_id=OTHER_ORG_ID),
        _request_row(id=REQUEST_B, endpoint_id=ENDPOINT_B, endpoint_label="code-review"),
    ]


def _project_request_row(**overrides: object) -> dict[str, object]:
    """Return one Project request with private mechanism fields populated."""
    row = _request_row(
        id=REQUEST_PROJECT_OK,
        endpoint_id=PROJECT_ID,
        endpoint_label="project-router",
        optimizer_project_id=PROJECT_ID,
        optimizer_project_billing_source="mixed",
        optimizer_project_billing_breakdown={
            "router_embedding": "host_managed",
            "selected_candidate": "customer_managed",
        },
        input_tokens=7,
        output_tokens=3,
        cached_tokens=1,
        cost_usd=0.000011,
        # Tenant-visible since the gateway-launch reclassification: the
        # customer-declared model id of the selected candidate.
        model="candidate-model",
        provider_model="provider-private",
        provider_connection_id="connection-private",
        routing_reason="routing-private",
    )
    row.update(overrides)
    return row


def test_list_scopes_to_org_and_window(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The default 7d window excludes nothing recent; orgs never mix."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/serving/requests")
    assert response.status_code == 200
    ids = {row["id"] for row in response.json()["requests"]}
    assert ids == {REQUEST_OK, REQUEST_ERROR, REQUEST_OLD, REQUEST_B}
    day = api.get(f"/api/orgs/{ORG_ID}/serving/requests", params={"window": "24h"})
    assert REQUEST_OLD not in {row["id"] for row in day.json()["requests"]}


def test_list_rows_carry_frontier_cost_and_hide_routing(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Rows are priced at the frontier anchor and never expose routing."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/serving/requests")
    row = next(r for r in response.json()["requests"] if r["id"] == REQUEST_OK)
    assert row["frontier_cost_usd"] == 10.0
    for hidden in (*sorted(_MECHANISM_KEYS), "request", "response"):
        assert hidden not in row


def test_list_filters_and_paginates(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Endpoint/status filters narrow; a full page returns a cursor that pages."""
    _seed(supabase)
    errors = api.get(
        f"/api/orgs/{ORG_ID}/serving/requests",
        params={"status": "error", "endpoint": ENDPOINT_A},
    )
    assert [row["id"] for row in errors.json()["requests"]] == [REQUEST_ERROR]

    first = api.get(f"/api/orgs/{ORG_ID}/serving/requests", params={"limit": 2}).json()
    assert len(first["requests"]) == 2
    cursor = first["next_cursor"]
    assert cursor is not None
    second = api.get(
        f"/api/orgs/{ORG_ID}/serving/requests",
        params={"limit": 2, "cursor_ts": cursor["ts"], "cursor_id": cursor["id"]},
    ).json()
    assert not {row["id"] for row in first["requests"]} & {row["id"] for row in second["requests"]}


def test_unknown_window_is_a_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The window shorthand fails loudly instead of silently defaulting."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/serving/requests", params={"window": "90d"})
    assert response.status_code == 400


def test_malformed_params_are_400s_not_500s(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Non-uuid ids, bad timestamps, unknown statuses, half cursors: all 400."""
    _seed(supabase)
    base = f"/api/orgs/{ORG_ID}/serving/requests"
    assert api.get(base, params={"endpoint": "not-a-uuid"}).status_code == 400
    assert api.get(base, params={"status": "failed"}).status_code == 400
    assert api.get(base, params={"cursor_ts": _iso(1)}).status_code == 400
    assert (
        api.get(base, params={"cursor_ts": "garbage", "cursor_id": REQUEST_OK}).status_code == 400
    )
    assert (
        api.get(base, params={"cursor_ts": _iso(1), "cursor_id": "not-a-uuid"}).status_code == 400
    )
    assert (
        api.get(f"/api/orgs/{ORG_ID}/serving/summary", params={"endpoint": "x"}).status_code == 400
    )
    assert api.get(f"{base}/not-a-uuid").status_code == 404


def test_cursor_freezes_the_window_lower_bound(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """next_cursor carries the first page's `after` and later pages reuse it."""
    _seed(supabase)
    first = api.get(f"/api/orgs/{ORG_ID}/serving/requests", params={"limit": 2}).json()
    cursor = first["next_cursor"]
    assert cursor["after"] is not None
    second = api.get(
        f"/api/orgs/{ORG_ID}/serving/requests",
        params={
            "limit": 2,
            "cursor_ts": cursor["ts"],
            "cursor_id": cursor["id"],
            "cursor_after": cursor["after"],
        },
    )
    assert second.status_code == 200
    assert second.json()["next_cursor"] is None or (
        second.json()["next_cursor"]["after"] == cursor["after"]
    )


def test_detail_returns_bodies_but_not_routing(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The detail fetch includes stored bodies and still hides routing."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/serving/requests/{REQUEST_OK}")
    assert response.status_code == 200
    payload = response.json()["request"]
    assert payload["request"]["messages"][0]["content"] == "hi"
    # The reclassified tenant field: which model served the call.
    assert payload["model"] == "internal-model-a"
    for hidden in sorted(_MECHANISM_KEYS):
        assert hidden not in payload


def test_project_filter_exposes_safe_sources_and_suppresses_ambiguous_frontier(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """Project telemetry is filterable, source-honest, and never prices reservations."""
    _seed(supabase)
    supabase.tables["serving_requests"].extend(
        [
            _project_request_row(),
            _project_request_row(
                id=REQUEST_PROJECT_AMBIGUOUS,
                status="error",
                error_message="outcome_ambiguous",
                input_tokens=1_000,
                output_tokens=500,
                cached_tokens=0,
                cost_usd=0.250000,
            ),
        ]
    )

    listed = api.get(
        f"/api/orgs/{ORG_ID}/serving/requests",
        params={"project_id": PROJECT_ID},
    )
    assert listed.status_code == 200
    rows = {row["id"]: row for row in listed.json()["requests"]}
    assert set(rows) == {REQUEST_PROJECT_OK, REQUEST_PROJECT_AMBIGUOUS}
    assert rows[REQUEST_PROJECT_OK]["project_id"] == PROJECT_ID
    assert rows[REQUEST_PROJECT_OK]["billing_source"] == "mixed"
    assert rows[REQUEST_PROJECT_OK]["billing_components"] == {
        "router_embedding": "host_managed",
        "selected_candidate": "customer_managed",
    }
    assert rows[REQUEST_PROJECT_OK]["frontier_cost_usd"] is not None
    assert rows[REQUEST_PROJECT_AMBIGUOUS]["frontier_cost_usd"] is None

    ambiguous = api.get(f"/api/orgs/{ORG_ID}/serving/requests/{REQUEST_PROJECT_AMBIGUOUS}")
    assert ambiguous.status_code == 200
    detail = ambiguous.json()["request"]
    assert detail["frontier_cost_usd"] is None
    assert detail["cost_usd"] == 0.25
    assert detail["input_tokens"] == 1_000
    # WHICH model served is tenant data now; WHY it was chosen is not.
    assert detail["model"] == "candidate-model"
    for private in (
        "provider-private",
        "connection-private",
        "routing-private",
    ):
        assert private not in f"{listed.text}\n{ambiguous.text}"

    summary = api.get(
        f"/api/orgs/{ORG_ID}/serving/summary",
        params={"project_id": PROJECT_ID},
    )
    assert summary.status_code == 200
    assert summary.json()["stats"]["request_count"] == 2
    assert summary.json()["stats"]["error_count"] == 1


def test_project_and_legacy_filters_are_mutually_exclusive(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """A telemetry request cannot combine incompatible namespace filters."""
    _seed(supabase)
    list_response = api.get(
        f"/api/orgs/{ORG_ID}/serving/requests",
        params={"endpoint": ENDPOINT_A, "project_id": PROJECT_ID},
    )
    summary_response = api.get(
        f"/api/orgs/{ORG_ID}/serving/summary",
        params={"endpoint": ENDPOINT_A, "project_id": PROJECT_ID},
    )
    malformed = api.get(
        f"/api/orgs/{ORG_ID}/serving/requests",
        params={"project_id": "not-a-uuid"},
    )

    assert list_response.status_code == 400
    assert summary_response.status_code == 400
    assert malformed.status_code == 400


def test_detail_hides_other_orgs(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Point reads 404 for requests owned by another org."""
    _seed(supabase)
    assert api.get(f"/api/orgs/{ORG_ID}/serving/requests/{REQUEST_OTHER_ORG}").status_code == 404
    assert api.get(f"/api/orgs/{ORG_ID}/serving/requests/request-missing").status_code == 404


def test_summary_aggregates_buckets_and_endpoints(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The summary carries hero stats, chart buckets, and the endpoint list."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/serving/summary")
    assert response.status_code == 200
    payload = response.json()
    assert payload["window"] == "7d"
    assert payload["stats"]["request_count"] == 4
    assert payload["stats"]["error_count"] == 1
    assert payload["stats"]["unpriced_count"] == 0
    assert "frontier_cost_usd_total" not in payload["stats"]
    assert sum(bucket["request_count"] for bucket in payload["buckets"]) == 4
    labels = {endpoint["endpoint_label"] for endpoint in payload["endpoints"]}
    assert labels == {"support-triage", "code-review"}


def test_summary_payload_is_unchanged_by_the_fan_out(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Issuing the three reads together changes latency, never the response.

    The handler became ``async def`` to overlap them, which also moves its
    membership check onto the event loop unless that is threaded too; asserting
    the whole payload (and the 404 below) is what pins both.
    """
    _seed(supabase)

    payload = api.get(f"/api/orgs/{ORG_ID}/serving/summary").json()
    repeated = api.get(f"/api/orgs/{ORG_ID}/serving/summary").json()

    assert payload == repeated
    assert set(payload) == {"window", "bucket_seconds", "stats", "buckets", "endpoints"}
    assert payload["stats"]["request_count"] == 4
    assert sum(bucket["request_count"] for bucket in payload["buckets"]) == 4
    assert {row["endpoint_label"] for row in payload["endpoints"]} == {
        "support-triage",
        "code-review",
    }


def test_summary_still_hides_a_foreign_org(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The membership gate survived the move onto the event loop."""
    _seed(supabase)
    assert api.get(f"/api/orgs/{OTHER_ORG_ID}/serving/summary").status_code == 404


def test_summary_endpoint_filter_keeps_endpoint_list_unfiltered(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Filtering stats to one endpoint must not empty the dropdown source."""
    _seed(supabase)
    response = api.get(
        f"/api/orgs/{ORG_ID}/serving/summary", params={"endpoint": ENDPOINT_B}
    ).json()
    assert response["stats"]["request_count"] == 1
    assert len(response["endpoints"]) == 2


def test_endpoints_probe_lists_served_endpoints_only_for_the_org(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The endpoints probe is the sidebar gate: org-scoped, empty when unserved."""
    _seed(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/serving/endpoints")
    assert response.status_code == 200
    labels = {endpoint["endpoint_label"] for endpoint in response.json()["endpoints"]}
    assert labels == {"support-triage", "code-review"}
    supabase.tables["serving_requests"] = [_request_row(org_id=OTHER_ORG_ID)]
    assert api.get(f"/api/orgs/{ORG_ID}/serving/endpoints").json()["endpoints"] == []


def _assert_no_routing_keys(payload: object, forbidden: frozenset[str]) -> None:
    """Recursively assert that ``forbidden`` keys never serialize.

    ``request``/``response`` bodies are exempt below their own key: they are
    customer-authored payloads, and an OpenAI-compatible body legitimately
    carries a ``model`` field the customer sent.
    """
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in ("request", "response"):
                continue
            assert key not in forbidden, f"routing field {key!r} leaked into a read path"
            _assert_no_routing_keys(value, forbidden)
    elif isinstance(payload, list):
        for item in payload:
            _assert_no_routing_keys(item, forbidden)


def test_telemetry_reads_serialize_no_routing_fields(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Regression gate for the Telemetry opacity ruling (product decision 2026-07-23).

    Scoped to Telemetry, which is what the ruling covers. Every mechanism field
    is stored on every seeded row here, so if any of these reads starts
    serializing one (a view stops stripping, a new endpoint dumps records raw),
    the walk fails. The admin audit is deliberately absent because its entire
    job is serving the routing decision to platform operators. ``model`` is no
    longer walked: the gateway-launch reclassification (2026-08-19) made it
    tenant-visible while the rest of the mechanism stayed operator-only.
    """
    _seed(supabase)
    read_paths = (
        f"/api/orgs/{ORG_ID}/serving/requests",
        f"/api/orgs/{ORG_ID}/serving/requests?status=error",
        f"/api/orgs/{ORG_ID}/serving/requests/{REQUEST_OK}",
        f"/api/orgs/{ORG_ID}/serving/summary",
        f"/api/orgs/{ORG_ID}/serving/summary?window=24h",
        f"/api/orgs/{ORG_ID}/serving/endpoints",
    )
    for path in read_paths:
        response = api.get(path)
        assert response.status_code == 200, path
        _assert_no_routing_keys(response.json(), _MECHANISM_KEYS)


def test_summary_empty_org_signals_nothing_served(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """No traffic yet: zero stats and an empty endpoint list gate the surface."""
    response = api.get(f"/api/orgs/{ORG_ID}/serving/summary")
    assert response.status_code == 200
    payload = response.json()
    assert payload["stats"]["request_count"] == 0
    assert payload["endpoints"] == []


def test_audit_explains_one_call_to_an_operator(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The audit answers why the call routed where it did, with its tenant named."""
    _seed(supabase)
    response = api.get(f"/api/admin/serving-requests/{REQUEST_OK}", headers=_ADMIN)
    assert response.status_code == 200
    payload = response.json()
    audited = payload["request"]
    assert audited["cluster_id"] == "cluster-0"
    assert audited["cluster_label"] == "billing-questions"
    assert audited["routing_reason"] == (
        "cluster-0 routes to the cheapest model above the quality floor"
    )
    assert audited["model"] == "internal-model-a"
    assert audited["provider_model"] == "us.anthropic.claude-haiku-4-5-v1:0"
    # A free policy reports a real zero; the audit must not round it to absent.
    assert audited["router_cost_usd"] == 0.0
    assert audited["leg"] == "serving"
    assert audited["endpoint_label"] == "support-triage"
    assert audited["cost_usd"] == 0.003
    assert audited["latency_ms"] == 310
    assert audited["ttfb_ms"] == 90
    assert audited["cached_tokens"] == 0
    assert audited["status"] == "ok"
    # Bodies belong to the tenant detail route, not to the decision audit.
    assert "request" not in audited
    assert "response" not in audited
    assert payload["org"] == {
        "id": ORG_ID,
        "name": "Experiential Labs",
        "slug": "experiential-labs",
    }


def test_audit_reads_any_org_and_404s_on_a_missing_row(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Cross-org by design (a completion id is the whole address); absent ids 404."""
    _seed(supabase)
    foreign = api.get(f"/api/admin/serving-requests/{REQUEST_OTHER_ORG}", headers=_ADMIN)
    assert foreign.status_code == 200
    assert foreign.json()["org"]["id"] == OTHER_ORG_ID
    assert api.get("/api/admin/serving-requests/not-a-uuid", headers=_ADMIN).status_code == 404
    assert (
        api.get(
            f"/api/admin/serving-requests/{'aaaa0000-0000-4000-8000-00000000dead'}",
            headers=_ADMIN,
        ).status_code
        == 404
    )


def test_audit_is_invisible_to_non_admins(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """An org admin is not a platform admin: 404, so the surface is not enumerable."""
    _seed(supabase)
    # `api`'s default actor is an admin of the org that owns REQUEST_OK, and it
    # can read the row's tenant view - the mechanism is what it must not reach.
    assert api.get(f"/api/orgs/{ORG_ID}/serving/requests/{REQUEST_OK}").status_code == 200
    denied = api.get(f"/api/admin/serving-requests/{REQUEST_OK}")
    assert denied.status_code == 404
    # The same body a missing route answers with: no hint that anything is here.
    assert denied.json()["error"] == "Not found"
