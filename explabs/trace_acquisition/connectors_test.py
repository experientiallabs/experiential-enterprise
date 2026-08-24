# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Contract tests for the six bounded Platform-owned remote transports."""

from __future__ import annotations

import json
from contextlib import AbstractContextManager
from typing import Self

import httpx
import pytest
from psycopg import sql

import explabs.trace_acquisition.connectors as connector_module
from explabs.trace_acquisition.connectors import (
    REMOTE_TRACE_TRANSPORTS,
    AcquisitionErrorCode,
    BraintrustConnector,
    ConnectorError,
    ConnectorRequest,
    LangfuseConnector,
    LangSmithConnector,
    MastraConnector,
    PostgresConnector,
    PostHogConnector,
    TraceTransportKind,
    connector_registry,
)
from explabs.trace_acquisition.formats import TraceUploadFormat


def _request(
    source_format: TraceUploadFormat,
    config: dict[str, object] | None = None,
    *,
    since: str | None = None,
) -> ConnectorRequest:
    """Build one connector request with safe non-secret config."""
    return ConnectorRequest(source_format=source_format, config=config or {}, since=since)


def test_registry_contains_exact_six_remote_transports_and_no_phoenix_pull() -> None:
    """Upload support never manufactures upload or Phoenix live transports."""
    with httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200))
    ) as client:
        registry = connector_registry(client)

    assert {kind.value for kind in REMOTE_TRACE_TRANSPORTS} == {
        "langfuse",
        "langsmith",
        "braintrust",
        "posthog",
        "mastra",
        "postgres",
    }
    with pytest.raises(ConnectorError) as raised:
        registry.get(TraceTransportKind.UPLOAD)
    assert raised.value.code is AcquisitionErrorCode.INVALID_SOURCE_CONFIG


def test_langfuse_paginates_listing_and_fetches_complete_trace() -> None:
    """Langfuse preserves the page cursor and full-trace detail request."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Return one listing row and its detail payload."""
        requests.append(request)
        if request.url.path == "/api/public/traces":
            return httpx.Response(200, json={"data": [{"id": "trace/id"}]})
        return httpx.Response(200, json={"id": "trace/id", "observations": []})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        batch = LangfuseConnector(client).fetch_page(
            _request(TraceUploadFormat.LANGFUSE, since="2026-08-01T00:00:00Z"),
            credential="pk-live:sk-secret",
            cursor="1",
            limit=1,
        )

    assert batch.records == ({"id": "trace/id", "observations": []},)
    assert batch.next_cursor == "2"
    assert requests[0].url.params["page"] == "1"
    assert requests[0].url.params["fromTimestamp"].startswith("2026-08-01")
    assert requests[1].url.raw_path.endswith(b"/trace%2Fid")
    assert requests[0].headers["authorization"].startswith("Basic ")


def test_langsmith_passes_and_returns_opaque_cursor() -> None:
    """LangSmith resumes with the server's cursor rather than inventing offsets."""
    bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Capture the query body and return one cursor page."""
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"runs": [{"id": "run-1"}], "cursors": {"next": "opaque-next"}},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        batch = LangSmithConnector(client).fetch_page(
            _request(TraceUploadFormat.LANGSMITH, {"project": "prod"}),
            credential="ls-secret",
            cursor="opaque-current",
            limit=20,
        )

    assert batch.records == ({"id": "run-1"},)
    assert batch.next_cursor == "opaque-next"
    assert bodies == [{"limit": 20, "session": ["prod"], "cursor": "opaque-current"}]


def test_braintrust_resolves_exact_project_name_then_uses_logs_cursor() -> None:
    """Braintrust resolves a name safely and preserves its logs cursor."""
    project_id = "148e8975-35fa-410f-9d1c-85d46be47d7f"
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Model project lookup followed by one project-logs page."""
        paths.append(request.url.path)
        if request.url.path == "/v1/project":
            return httpx.Response(200, json={"objects": [{"name": "prod", "id": project_id}]})
        return httpx.Response(
            200,
            json={"events": [{"id": "event-1"}], "cursor": "next-event"},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        batch = BraintrustConnector(client).fetch_page(
            _request(TraceUploadFormat.BRAINTRUST, {"project": "prod"}),
            credential="bt-secret",
            cursor="current-event",
            limit=10,
        )

    assert batch.records == ({"id": "event-1"},)
    assert batch.next_cursor == "next-event"
    assert paths == ["/v1/project", f"/v1/project_logs/{project_id}/fetch"]


def test_posthog_executes_one_hard_limited_hogql_query() -> None:
    """PostHog uses one bounded query and projects typed event objects."""
    queries: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Capture HogQL and return one result tuple."""
        body = json.loads(request.content)
        assert isinstance(body, dict)
        query = body["query"]
        assert isinstance(query, dict)
        queries.append(str(query["query"]))
        return httpx.Response(
            200,
            json={"results": [["$ai_generation", '{"model":"gpt"}', "2026-08-01"]]},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        batch = PostHogConnector(client).fetch_page(
            _request(
                TraceUploadFormat.POSTHOG,
                {"project": "42"},
                since="2026-08-01T00:00:00Z",
            ),
            credential="ph-secret",
            cursor=None,
            limit=37,
        )

    assert batch.records[0] == {
        "event": "$ai_generation",
        "properties": {"model": "gpt"},
        "timestamp": "2026-08-01",
    }
    assert "limit 37" in queries[0].casefold()
    assert "timestamp >=" in queries[0].casefold()


def test_mastra_uses_page_and_per_page_pagination() -> None:
    """Mastra converts its integer cursor into page/perPage parameters."""
    seen_url: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Return a full page so the connector emits its next page cursor."""
        seen_url.append(request.url)
        return httpx.Response(200, json={"traces": [{"id": "one"}, {"id": "two"}]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        batch = MastraConnector(client).fetch_page(
            _request(TraceUploadFormat.MASTRA, {"host": "https://mastra.example.com"}),
            credential="mastra-secret",
            cursor="3",
            limit=2,
        )

    assert len(batch.records) == 2
    assert batch.next_cursor == "4"
    assert dict(seen_url[0].params) == {"page": "3", "perPage": "2"}


class _FakeCursor(AbstractContextManager["_FakeCursor"]):
    """Minimal psycopg cursor recording bounded statement parameters."""

    def __init__(self) -> None:
        self.executions: list[tuple[object, object]] = []

    def __enter__(self) -> Self:
        """Enter the fake cursor context."""
        return self

    def __exit__(self, *args: object) -> None:
        """Exit without suppressing failures."""
        _ = args

    def execute(self, query: object, params: object = None) -> None:
        """Record one statement and its parameters."""
        self.executions.append((query, params))

    def fetchall(self) -> list[tuple[object]]:
        """Return JSON-compatible payload rows."""
        return [({"trace": 1},), ('{"trace":2}',)]


class _FakeConnection(AbstractContextManager["_FakeConnection"]):
    """Minimal psycopg connection returning one shared fake cursor."""

    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> Self:
        """Enter the fake connection context."""
        return self

    def __exit__(self, *args: object) -> None:
        """Exit without suppressing failures."""
        _ = args

    def cursor(self) -> _FakeCursor:
        """Return the recording cursor."""
        return self._cursor


def test_postgres_quotes_identifiers_and_enforces_single_page_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Postgres accepts only identifiers and binds the 1,000-record cap."""
    cursor = _FakeCursor()
    credentials: list[str] = []

    def connect(credential: str, *, connect_timeout: int) -> _FakeConnection:
        """Capture the transient DSN without persisting it."""
        assert connect_timeout == 10
        credentials.append(credential)
        return _FakeConnection(cursor)

    monkeypatch.setattr(connector_module.psycopg, "connect", connect)
    batch = PostgresConnector().fetch_page(
        _request(
            TraceUploadFormat.OTLP,
            {"table": "public.traces", "payload_column": "payload", "order_column": "ts"},
            since="2026-08-01T00:00:00Z",
        ),
        credential="postgresql://user:secret@db.example.com/app",
        cursor=None,
        limit=10_000,
    )

    assert batch.records == ({"trace": 1}, {"trace": 2})
    assert credentials == ["postgresql://user:secret@db.example.com/app"]
    query, params = cursor.executions[-1]
    assert isinstance(query, sql.Composed)
    assert params == ["2026-08-01T00:00:00Z", 1_000]
    with pytest.raises(ConnectorError) as raised:
        PostgresConnector().fetch_page(
            _request(TraceUploadFormat.OTLP, {"table": "traces; drop table users"}),
            credential="secret-dsn",
            cursor=None,
            limit=1,
        )
    assert raised.value.code is AcquisitionErrorCode.INVALID_SOURCE_CONFIG


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (401, AcquisitionErrorCode.BAD_CREDENTIALS),
        (429, AcquisitionErrorCode.RATE_LIMITED),
        (503, AcquisitionErrorCode.SOURCE_UNAVAILABLE),
    ],
)
def test_http_failures_reduce_to_stable_codes_without_vendor_body(
    status_code: int,
    expected: AcquisitionErrorCode,
) -> None:
    """Provider status/body/secret details never survive the connector boundary."""
    raw_secret = "do-not-persist-me"

    def handler(_request: httpx.Request) -> httpx.Response:
        """Return a hostile vendor body that must be erased."""
        return httpx.Response(status_code, text=f"vendor leaked {raw_secret}")

    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ConnectorError) as raised,
    ):
        LangSmithConnector(client).fetch_page(
            _request(TraceUploadFormat.LANGSMITH),
            credential=raw_secret,
            cursor=None,
            limit=1,
        )
    assert raised.value.code is expected
    assert raw_secret not in str(raised.value)
    assert "vendor leaked" not in str(raised.value)


def test_http_response_bytes_cannot_exceed_the_object_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A live HTTP source fails before parsing a response beyond the byte cap."""
    monkeypatch.setattr(connector_module, "MAX_TRACE_OBJECT_BYTES", 5)

    def handler(_request: httpx.Request) -> httpx.Response:
        """Return valid JSON whose raw response is over the patched bound."""
        return httpx.Response(200, content=b'{"runs":[]}')

    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ConnectorError) as raised,
    ):
        LangSmithConnector(client).fetch_page(
            _request(TraceUploadFormat.LANGSMITH),
            credential="secret",
            cursor=None,
            limit=1,
        )
    assert raised.value.code is AcquisitionErrorCode.OBJECT_TOO_LARGE


@pytest.mark.parametrize(
    "host",
    [
        "http://vendor.example.com",
        "https://localhost",
        "https://localhost.",
        "https://127.0.0.1",
        "https://127.1",
        "https://metadata.google.internal",
        "https://user:pass@vendor.example.com",
        "https://vendor.example.com/path",
        "https://vendor.example.com:invalid",
    ],
)
def test_configured_http_hosts_fail_closed_against_obvious_ssrf(host: str) -> None:
    """Unsafe scheme, authority, path, and private-address hosts are rejected."""
    with (
        httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(200))) as client,
        pytest.raises(ConnectorError) as raised,
    ):
        LangSmithConnector(client).fetch_page(
            _request(TraceUploadFormat.LANGSMITH, {"host": host}),
            credential="secret",
            cursor=None,
            limit=1,
        )
    assert raised.value.code is AcquisitionErrorCode.INVALID_SOURCE_CONFIG
