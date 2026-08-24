# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the captured-prompt broadcast tick."""

from __future__ import annotations

import json

import httpx

from explabs.broadcast import run_broadcast
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import JsonObject

_ORG_ENABLED = "00000000-0000-0000-0000-00000000c001"
_ORG_UNCONNECTED = "00000000-0000-0000-0000-00000000c002"


def _captured(request_id: str, org_id: str, **overrides: object) -> JsonObject:
    row: JsonObject = {
        "request_id": request_id,
        "org_id": org_id,
        "prompt_sha256": "ab12" * 16,
        "messages": [{"role": "user", "content": "hello"}],
        "captured_at": "2026-08-22T10:00:00+00:00",
        "exported_at": None,
    }
    row.update(overrides)
    return row


def _client_with_rows(*, broadcast_config: JsonObject | None = None) -> FakeSupabaseClient:
    client = FakeSupabaseClient()
    client.tables["organizations"] = [
        {"id": _ORG_ENABLED, "capture_prompt_content": True},
        {"id": _ORG_UNCONNECTED, "capture_prompt_content": True},
    ]
    client.tables["gateway_requests"] = [
        {"request_id": "request-1", "alias": "claude-fable-5"},
        {"request_id": "request-2", "alias": "claude-opus-5"},
    ]
    client.tables["gateway_captured_prompts"] = [
        _captured("request-1", _ORG_ENABLED),
        _captured("request-2", _ORG_UNCONNECTED),
    ]
    config: JsonObject = {"project": "gateway-broadcast-tests"}
    config["broadcast"] = (
        {"enabled": True, "privacy_mode": False} if broadcast_config is None else broadcast_config
    )
    client.tables["trace_connections"] = [
        {
            "id": "conn-1",
            "org_id": _ORG_ENABLED,
            "kind": "braintrust",
            "config": config,
            "credential_last4": "il69",
        }
    ]
    client.vault_secrets["conn-1"] = "sk-braintrust-test"
    return client


def _braintrust_transport(record: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        record.append(request)
        if request.url.path == "/v1/project":
            return httpx.Response(200, json={"id": "proj-123"})
        if request.url.path == "/v1/project_logs/proj-123/insert":
            return httpx.Response(200, json={"row_ids": ["r1"]})
        return httpx.Response(404, json={"error": "unexpected"})

    return httpx.MockTransport(handler)


def test_broadcast_delivers_enabled_orgs_and_stamps_rows() -> None:
    """Enabled destinations receive content; every queue row is stamped."""
    client = _client_with_rows()
    requests: list[httpx.Request] = []

    summary = run_broadcast(client, transport=_braintrust_transport(requests))

    assert summary.broadcast == 1
    assert summary.skipped_no_destination == 1
    assert summary.failed == 0
    # Both rows are stamped: delivered for the enabled org, nowhere-to-send
    # for the unconnected one; the queue drains either way.
    assert all(row["exported_at"] is not None for row in client.tables["gateway_captured_prompts"])
    # The insert carried the prompt as input plus content-free metadata, under
    # the connection's own project and credential.
    insert = next(r for r in requests if r.url.path.endswith("/insert"))
    assert insert.headers["authorization"] == "Bearer sk-braintrust-test"
    body = json.loads(insert.content)
    event = body["events"][0]
    assert event["input"] == [{"role": "user", "content": "hello"}]
    assert event["metadata"]["model"] == "claude-fable-5"
    assert event["metadata"]["prompt_group"] == "ab12ab12ab12"
    project = next(r for r in requests if r.url.path == "/v1/project")
    assert json.loads(project.content) == {"name": "gateway-broadcast-tests"}


def test_connected_but_not_enabled_never_ships() -> None:
    """Connecting a destination is not consent to broadcast: explicit opt-in."""
    client = _client_with_rows(broadcast_config={"enabled": False})

    def explode(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
        msg = "a disabled destination must never receive traffic"
        raise AssertionError(msg)

    summary = run_broadcast(client, transport=httpx.MockTransport(explode))

    assert summary.broadcast == 0
    # Both orgs' rows stamp as nowhere-to-send: the table is their store of
    # record until broadcast is explicitly enabled.
    assert summary.skipped_no_destination == 2
    assert all(row["exported_at"] is not None for row in client.tables["gateway_captured_prompts"])


def test_privacy_mode_strips_content_and_keeps_metadata() -> None:
    """Privacy mode ships metadata-only events: no input field at all."""
    client = _client_with_rows(broadcast_config={"enabled": True, "privacy_mode": True})
    requests: list[httpx.Request] = []

    summary = run_broadcast(client, transport=_braintrust_transport(requests))

    assert summary.broadcast == 1
    insert = next(r for r in requests if r.url.path.endswith("/insert"))
    event = json.loads(insert.content)["events"][0]
    assert "input" not in event
    assert event["metadata"]["request_id"] == "request-1"
    assert event["metadata"]["model"] == "claude-fable-5"


def test_broadcast_failure_leaves_rows_queued_for_retry() -> None:
    """A destination outage keeps the org's rows queued; nothing is lost."""
    client = _client_with_rows()

    def down(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "down"})

    summary = run_broadcast(client, transport=httpx.MockTransport(down))

    assert summary.failed == 1
    assert summary.skipped_no_destination == 1
    enabled_row = next(
        row for row in client.tables["gateway_captured_prompts"] if row["org_id"] == _ORG_ENABLED
    )
    assert enabled_row["exported_at"] is None


def test_drain_loop_empties_a_queue_larger_than_one_batch() -> None:
    """One tick drains past the batch size instead of capping throughput."""
    client = _client_with_rows()
    client.tables["gateway_requests"] = [
        {"request_id": f"request-{index}", "alias": "claude-fable-5"} for index in range(250)
    ]
    client.tables["gateway_captured_prompts"] = [
        _captured(
            f"request-{index}", _ORG_ENABLED, captured_at=f"2026-08-22T10:00:{index % 60:02d}+00:00"
        )
        for index in range(250)
    ]
    requests: list[httpx.Request] = []

    summary = run_broadcast(client, transport=_braintrust_transport(requests))

    assert summary.broadcast == 250
    assert all(row["exported_at"] is not None for row in client.tables["gateway_captured_prompts"])
    # Three insert batches (100 + 100 + 50), not one capped batch.
    assert sum(1 for r in requests if r.url.path.endswith("/insert")) == 3


def test_failed_org_does_not_block_orgs_behind_it() -> None:
    """A down destination's backlog never starves other orgs in the tick."""
    client = _client_with_rows()
    # The failing org owns the oldest 120 rows; the unconnected org's row
    # sits behind that backlog, beyond the first batch.
    client.tables["gateway_requests"] = [
        {"request_id": f"request-{index}", "alias": "claude-fable-5"} for index in range(120)
    ] + [{"request_id": "request-late", "alias": "claude-opus-5"}]
    client.tables["gateway_captured_prompts"] = [
        _captured(
            f"request-{index}",
            _ORG_ENABLED,
            captured_at=f"2026-08-22T09:{index // 60:02d}:{index % 60:02d}+00:00",
        )
        for index in range(120)
    ] + [_captured("request-late", _ORG_UNCONNECTED, captured_at="2026-08-22T10:30:00+00:00")]

    def down(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "down"})

    summary = run_broadcast(client, transport=httpx.MockTransport(down))

    # The failing org is attempted once (first batch's 100 rows), then
    # excluded; the org queued behind it still drains this same tick.
    assert summary.failed == 100
    assert summary.skipped_no_destination == 1
    late_row = next(
        row
        for row in client.tables["gateway_captured_prompts"]
        if row["request_id"] == "request-late"
    )
    assert late_row["exported_at"] is not None


def test_broadcast_with_empty_queue_is_a_quiet_noop() -> None:
    """No pending rows: no connections read, no HTTP, zero summary."""
    client = FakeSupabaseClient()

    def explode(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
        msg = "the broadcaster must not call out with an empty queue"
        raise AssertionError(msg)

    summary = run_broadcast(client, transport=httpx.MockTransport(explode))

    assert (summary.broadcast, summary.skipped_no_destination, summary.failed) == (0, 0, 0)


def _single_org_client(connections: list[JsonObject]) -> FakeSupabaseClient:
    """One enabled org with one captured row and the given connections."""
    client = FakeSupabaseClient()
    client.tables["organizations"] = [{"id": _ORG_ENABLED, "capture_prompt_content": True}]
    client.tables["gateway_requests"] = [{"request_id": "request-1", "alias": "claude-fable-5"}]
    client.tables["gateway_captured_prompts"] = [_captured("request-1", _ORG_ENABLED)]
    client.tables["trace_connections"] = connections
    return client


def _connection(kind: str, config: JsonObject, *, connection_id: str = "conn-1") -> JsonObject:
    return {
        "id": connection_id,
        "org_id": _ORG_ENABLED,
        "kind": kind,
        "config": config,
        "credential_last4": "1234",
    }


def test_langfuse_ships_otlp_json_with_basic_auth() -> None:
    """Langfuse receives an OTLP/JSON export at its OTel endpoint."""
    client = _single_org_client([_connection("langfuse", {"broadcast": {"enabled": True}})])
    client.vault_secrets["conn-1"] = "pk-lf-pub:sk-lf-sec"
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={})

    summary = run_broadcast(client, transport=httpx.MockTransport(handler))

    assert summary.broadcast == 1
    (request,) = requests
    assert request.url == "https://cloud.langfuse.com/api/public/otel/v1/traces"
    # Basic auth from the stored public:secret pair.
    assert request.headers["authorization"].startswith("Basic ")
    span = json.loads(request.content)["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    attributes = {attr["key"]: attr["value"]["stringValue"] for attr in span["attributes"]}
    assert attributes["llm.model_name"] == "claude-fable-5"
    assert json.loads(attributes["input.value"]) == [{"role": "user", "content": "hello"}]
    assert attributes["explabs.prompt_group"] == "ab12ab12ab12"
    assert len(span["traceId"]) == 32
    assert len(span["spanId"]) == 16


def test_phoenix_requires_a_host_and_ships_otlp_privacy_stripped() -> None:
    """Phoenix gets OTLP at the declared host; privacy mode drops input.value."""
    client = _single_org_client(
        [
            _connection(
                "phoenix",
                {
                    "host": "https://phoenix.example.com",
                    "broadcast": {"enabled": True, "privacy_mode": True},
                },
            )
        ]
    )
    client.vault_secrets["conn-1"] = "phoenix-key"
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={})

    summary = run_broadcast(client, transport=httpx.MockTransport(handler))

    assert summary.broadcast == 1
    (request,) = requests
    assert request.url == "https://phoenix.example.com/v1/traces"
    assert request.headers["authorization"] == "Bearer phoenix-key"
    assert request.headers["api_key"] == "phoenix-key"
    span = json.loads(request.content)["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    keys = {attr["key"] for attr in span["attributes"]}
    assert "input.value" not in keys
    assert "explabs.request_id" in keys


def test_phoenix_without_a_host_fails_loudly_and_requeues() -> None:
    """A hostless Phoenix destination is a misconfiguration, not a silent drop."""
    client = _single_org_client([_connection("phoenix", {"broadcast": {"enabled": True}})])
    client.vault_secrets["conn-1"] = "phoenix-key"

    summary = run_broadcast(client, transport=httpx.MockTransport(lambda _r: httpx.Response(200)))

    assert summary.failed == 1
    assert client.tables["gateway_captured_prompts"][0]["exported_at"] is None


def test_langsmith_posts_runs_and_treats_replay_conflict_as_delivered() -> None:
    """LangSmith gets one llm run per row; a 409 on the stable id is success."""
    client = _single_org_client([_connection("langsmith", {"broadcast": {"enabled": True}})])
    client.vault_secrets["conn-1"] = "ls-key"
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(409, json={"detail": "Run already exists"})

    summary = run_broadcast(client, transport=httpx.MockTransport(handler))

    assert summary.broadcast == 1
    (request,) = requests
    assert request.url == "https://api.smith.langchain.com/api/v1/runs"
    assert request.headers["x-api-key"] == "ls-key"
    body = json.loads(request.content)
    assert body["run_type"] == "llm"
    assert body["inputs"] == {"messages": [{"role": "user", "content": "hello"}]}
    assert body["session_name"] == "explabs-gateway-broadcast"
    assert body["extra"]["metadata"]["request_id"] == "request-1"


def test_posthog_captures_ai_generation_under_the_project_token() -> None:
    """PostHog gets a capture batch keyed by the public write-only token."""
    client = _single_org_client(
        [
            _connection(
                "posthog",
                {"broadcast": {"enabled": True, "capture_token": "phc_public"}},
            )
        ]
    )
    client.vault_secrets["conn-1"] = "phx_personal"
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"status": "Ok"})

    summary = run_broadcast(client, transport=httpx.MockTransport(handler))

    assert summary.broadcast == 1
    (request,) = requests
    assert request.url == "https://us.posthog.com/batch/"
    body = json.loads(request.content)
    # The capture token ships, never the private stored credential.
    assert body["api_key"] == "phc_public"
    assert "phx_personal" not in request.content.decode()
    event = body["batch"][0]
    assert event["event"] == "$ai_generation"
    assert event["properties"]["$ai_model"] == "claude-fable-5"
    assert event["properties"]["$ai_input"] == [{"role": "user", "content": "hello"}]
    assert event["uuid"]  # deterministic dedupe key


def test_posthog_without_a_capture_token_fails_loudly_and_requeues() -> None:
    """An enabled PostHog destination without its token is a misconfiguration."""
    client = _single_org_client([_connection("posthog", {"broadcast": {"enabled": True}})])
    client.vault_secrets["conn-1"] = "phx_personal"

    summary = run_broadcast(client, transport=httpx.MockTransport(lambda _r: httpx.Response(200)))

    assert summary.failed == 1
    assert client.tables["gateway_captured_prompts"][0]["exported_at"] is None


def test_multiple_enabled_destinations_all_receive_one_claim() -> None:
    """Two enabled destinations both get the batch; the row counts once."""
    client = _single_org_client(
        [
            _connection(
                "braintrust",
                {"project": "multi", "broadcast": {"enabled": True}},
                connection_id="conn-bt",
            ),
            _connection(
                "langsmith",
                {"broadcast": {"enabled": True, "privacy_mode": True}},
                connection_id="conn-ls",
            ),
        ]
    )
    client.vault_secrets["conn-bt"] = "bt-key"
    client.vault_secrets["conn-ls"] = "ls-key"
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/v1/project":
            return httpx.Response(200, json={"id": "proj-1"})
        return httpx.Response(200, json={})

    summary = run_broadcast(client, transport=httpx.MockTransport(handler))

    assert summary.broadcast == 1
    paths = [request.url.path for request in requests]
    assert "/v1/project_logs/proj-1/insert" in paths
    assert "/api/v1/runs" in paths
    # Privacy mode applies per destination: LangSmith got no content while
    # Braintrust carried the messages.
    run = json.loads(next(r for r in requests if r.url.path == "/api/v1/runs").content)
    assert run["inputs"] == {}
    insert = json.loads(next(r for r in requests if r.url.path.endswith("/insert")).content)
    assert insert["events"][0]["input"] == [{"role": "user", "content": "hello"}]
    assert insert["events"][0]["id"] == "request-1"


def test_one_failed_destination_requeues_for_every_destination() -> None:
    """A partial delivery releases the claim; deterministic ids absorb the redo."""
    client = _single_org_client(
        [
            _connection(
                "braintrust",
                {"project": "multi", "broadcast": {"enabled": True}},
                connection_id="conn-bt",
            ),
            _connection("langsmith", {"broadcast": {"enabled": True}}, connection_id="conn-ls"),
        ]
    )
    client.vault_secrets["conn-bt"] = "bt-key"
    client.vault_secrets["conn-ls"] = "ls-key"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/project":
            return httpx.Response(200, json={"id": "proj-1"})
        if request.url.path == "/api/v1/runs":
            return httpx.Response(503, json={"error": "down"})
        return httpx.Response(200, json={})

    summary = run_broadcast(client, transport=httpx.MockTransport(handler))

    assert summary.failed == 1
    assert summary.broadcast == 0
    assert client.tables["gateway_captured_prompts"][0]["exported_at"] is None


def test_broadcast_respects_revoked_consent() -> None:
    """Rows queued under an opt-in that was later revoked never ship."""
    client = _client_with_rows()
    for org in client.tables["organizations"]:
        org["capture_prompt_content"] = False

    def explode(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
        msg = "revoked-consent rows must never reach a destination"
        raise AssertionError(msg)

    summary = run_broadcast(client, transport=httpx.MockTransport(explode))

    assert (summary.broadcast, summary.skipped_no_destination, summary.failed) == (0, 0, 0)
    assert all(row["exported_at"] is None for row in client.tables["gateway_captured_prompts"])
