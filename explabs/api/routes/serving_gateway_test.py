# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Transparent /v1 edge proxy contracts and the official-SDK end-to-end proof."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import socket as _socket
from typing import ClassVar

import httpx
import openai
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from openai import OpenAI

from explabs.api.app import create_app
from explabs.api.conftest import TEST_API_KEY
from explabs.api.routes.serving_gateway import _models_list_cache, _ModelsListCache
from explabs.db.fake_supabase_test import FakeSupabaseClient

_WORKER_URL_ENV = "EXPLABS_GATEWAY_WORKER_URL"
_SSE_FRAMES = (
    b'data: {"choices": [{"index": 0, "delta": {"content": "hello "}}]}\n\n',
    b'data: {"choices": [{"index": 0, "delta": {"content": "world"}}]}\n\n',
    b"data: [DONE]\n\n",
)


def _unused_port() -> int:
    """Reserve one free loopback port."""
    with _socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@dataclass(frozen=True)
class _CapturedRequest:
    """One exact request as the worker stub received it."""

    method: str
    path: str
    headers: dict[str, str]
    body: bytes


class _WorkerStub(BaseHTTPRequestHandler):
    """Record every relayed request and answer like a gateway worker would.

    ``/v1/chat/completions`` streams SSE with a per-frame delay so tests can
    prove unbuffered relay; ``/v1/responses`` answers a canned 401 so tests
    can prove worker error bodies pass through verbatim; ``/v1/models``
    answers JSON with a worker-set response header.
    """

    captured: ClassVar[list[_CapturedRequest]] = []
    frame_delay_seconds: ClassVar[float] = 0.0

    def _record(self) -> None:
        """Capture the exact method, path, headers, and body bytes received."""
        length = int(self.headers.get("content-length", "0"))
        type(self).captured.append(
            _CapturedRequest(
                method=self.command,
                path=self.path,
                headers={name.lower(): value for name, value in self.headers.items()},
                body=self.rfile.read(length) if length else b"",
            )
        )

    def do_GET(self) -> None:
        """Serve the models list with a worker-identifying header."""
        self._record()
        body = json.dumps({"object": "list", "data": [{"id": "gw-stub-model"}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("x-request-id", "worker-req-1")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        """Stream chat SSE frames; answer Responses with a canned 401."""
        self._record()
        if self.path == "/v1/responses":
            body = json.dumps(
                {
                    "error": {
                        "message": "Incorrect API key provided.",
                        "type": "invalid_request_error",
                        "param": None,
                        "code": "invalid_api_key",
                    }
                }
            ).encode()
            self.send_response(401)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        # A deliberately repeated header: the transparent relay must forward
        # both occurrences, not collapse them to the last value.
        self.send_header("x-relay-multi", "first")
        self.send_header("x-relay-multi", "second")
        self.end_headers()
        for frame in _SSE_FRAMES:
            if type(self).frame_delay_seconds:
                time.sleep(type(self).frame_delay_seconds)
            self.wfile.write(frame)
            self.wfile.flush()

    def log_message(self, format: str, *args: object) -> None:
        """Suppress request logs so test output cannot retain payload context."""
        del format, args


@pytest.fixture
def worker_stub() -> Iterator[str]:
    """Serve the recording worker stub and yield its origin URL."""
    _WorkerStub.captured = []
    _WorkerStub.frame_delay_seconds = 0.0
    port = _unused_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), _WorkerStub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture(autouse=True)
def _reset_models_cache() -> Iterator[None]:
    """Isolate the process-wide /v1/models edge cache between tests."""
    _models_list_cache.clear()
    yield
    _models_list_cache.clear()


@pytest.fixture
def edge(worker_stub: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """Yield an edge client whose proxy points at the recording worker stub."""
    monkeypatch.setenv(_WORKER_URL_ENV, worker_stub)
    with TestClient(create_app(client=FakeSupabaseClient())) as client:
        yield client


def test_proxy_relays_caller_identity_headers_and_body_bytes_verbatim(
    edge: TestClient,
) -> None:
    """Authorization, Idempotency-Key, and X-Client-Request-Id pass unchanged.

    Today's replaced proxy minted a fresh uuid4 Idempotency-Key per call,
    which defeated worker-side replay; the body is deliberately NOT valid
    JSON to prove the edge never parses what it forwards.
    """
    response = edge.post(
        "/v1/chat/completions",
        content=b"not-json",
        headers={
            "Authorization": "Bearer xpl_edge_test_key",
            "Idempotency-Key": "caller-op-1",
            "X-Client-Request-Id": "caller-req-1",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 200
    (seen,) = _WorkerStub.captured
    assert seen.method == "POST"
    assert seen.path == "/v1/chat/completions"
    assert seen.body == b"not-json"
    assert seen.headers["authorization"] == "Bearer xpl_edge_test_key"
    assert seen.headers["idempotency-key"] == "caller-op-1"
    assert seen.headers["x-client-request-id"] == "caller-req-1"
    assert seen.headers["content-type"] == "application/json"


@pytest.mark.parametrize("scheme", ["bearer", "BEARER", "BeArEr"])
def test_proxy_canonicalizes_the_bearer_scheme_token(edge: TestClient, scheme: str) -> None:
    """RFC 7235 schemes are case-insensitive; the worker's prefix match is not.

    The edge normalizes the scheme token to exactly ``Bearer`` so a compliant
    client is not rejected upstream, while the credential passes untouched.
    """
    response = edge.get(
        "/v1/models",
        headers={"Authorization": f"{scheme} xpl_edge_test_key"},
    )

    assert response.status_code == 200
    (seen,) = _WorkerStub.captured
    assert seen.headers["authorization"] == "Bearer xpl_edge_test_key"


def test_proxy_leaves_non_bearer_authorization_untouched(edge: TestClient) -> None:
    """Only the bearer scheme is normalized; other schemes relay verbatim."""
    response = edge.get(
        "/v1/models",
        headers={"Authorization": "Basic dXNlcjpwYXNz"},
    )

    assert response.status_code == 200
    (seen,) = _WorkerStub.captured
    assert seen.headers["authorization"] == "Basic dXNlcjpwYXNz"


def test_proxy_forwards_the_query_string_verbatim(edge: TestClient) -> None:
    """The transparent proxy relays the caller's query string to the worker."""
    response = edge.get(
        "/v1/models?limit=3&after=gw-stub-model",
        headers={"Authorization": "Bearer xpl_edge_test_key"},
    )

    assert response.status_code == 200
    (seen,) = _WorkerStub.captured
    assert seen.path == "/v1/models?limit=3&after=gw-stub-model"


def test_proxy_never_mints_caller_operation_identities(edge: TestClient) -> None:
    """A caller sending no Idempotency-Key reaches the worker with none."""
    response = edge.post(
        "/v1/chat/completions",
        content=b"{}",
        headers={"Authorization": "Bearer xpl_edge_test_key"},
    )

    assert response.status_code == 200
    (seen,) = _WorkerStub.captured
    assert "idempotency-key" not in seen.headers
    assert "x-client-request-id" not in seen.headers


def test_repeated_worker_response_headers_relay_verbatim(edge: TestClient) -> None:
    """A header the worker repeats crosses the edge as two occurrences.

    Mapping-shaped forwarding would keep only the last value (Set-Cookie is
    the classic casualty); the streaming relay forwards the raw pairs.
    """
    response = edge.post(
        "/v1/chat/completions",
        content=b"{}",
        headers={"Authorization": "Bearer xpl_edge_test_key"},
    )

    assert response.status_code == 200
    assert response.headers.get_list("x-relay-multi") == ["first", "second"]


async def test_relay_timeout_bounds_only_the_tcp_connect_not_pool_waits() -> None:
    """The 10s bound is sock_connect; pool acquisition rides the 660s total.

    aiohttp's ``connect`` timeout also bounds pool acquisition: with every
    connector slot holding a long-running stream, a queued request would be
    502'd after 10s even though the worker is healthy and the request budget
    is open. httpx bounded pool waits by the total, so the swap must keep
    the short bound on the TCP connect alone.
    """
    from explabs.api.routes.serving_gateway import (
        _CONNECT_TIMEOUT_SECONDS,
        _TOTAL_TIMEOUT_SECONDS,
        _client,
    )

    app = create_app(client=FakeSupabaseClient(), gateway_only=True)
    request = Request({"type": "http", "app": app, "headers": [], "method": "GET", "path": "/"})
    session = _client(request)
    try:
        assert session.timeout.connect is None
        assert session.timeout.sock_connect == _CONNECT_TIMEOUT_SECONDS
        assert session.timeout.total == _TOTAL_TIMEOUT_SECONDS
    finally:
        await session.close()


def test_edge_does_not_prevalidate_the_bearer(edge: TestClient) -> None:
    """A request with no Authorization at all still reaches the worker.

    The worker is the auth authority; an edge that pre-validated keys would
    be a second authority that could disagree with it.
    """
    response = edge.get("/v1/models")

    assert response.status_code == 200
    (seen,) = _WorkerStub.captured
    assert "authorization" not in seen.headers
    assert response.headers["x-request-id"] == "worker-req-1"
    assert response.json()["data"] == [{"id": "gw-stub-model"}]


def test_streamed_sse_relays_incrementally(
    worker_stub: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SSE chunks arrive as the worker emits them, not after the stream ends.

    The edge runs on a real socket here because in-process test transports
    buffer whole responses, which would hide exactly the regression this
    guards against.
    """
    monkeypatch.setenv(_WORKER_URL_ENV, worker_stub)
    _WorkerStub.frame_delay_seconds = 0.15
    edge_port = _unused_port()
    edge = _UvicornThread(create_app(client=FakeSupabaseClient()), edge_port)
    arrivals: list[float] = []
    frames: list[str] = []
    try:
        edge.start(f"http://127.0.0.1:{edge_port}/health")
        started = time.monotonic()
        with (
            httpx.Client(timeout=10) as client,
            client.stream(
                "POST",
                f"http://127.0.0.1:{edge_port}/v1/chat/completions",
                content=b'{"stream": true}',
                headers={"Authorization": "Bearer xpl_edge_test_key"},
            ) as response,
        ):
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            for line in response.iter_lines():
                if line.startswith("data: "):
                    arrivals.append(time.monotonic() - started)
                    frames.append(line.removeprefix("data: "))
    finally:
        edge.stop()

    assert frames[-1] == "[DONE]"
    assert len(arrivals) == len(_SSE_FRAMES)
    # A buffered relay would deliver every frame at ~the total elapsed time.
    assert arrivals[0] < arrivals[-1] * 0.6


def test_edge_read_timeout_outlives_the_worker_request_deadline() -> None:
    """The edge must never cut a stream the worker is still allowed to produce.

    The edge bounds the whole relayed request (aiohttp's total wall timeout);
    if that bound were below the worker's own request deadline, a long
    streaming completion would be truncated at the edge before the worker
    emitted its terminal chunk. The edge total timeout therefore stays above
    the worker's default deadline.
    """
    from explabs.api.routes.serving_gateway import (
        _CONNECT_TIMEOUT_SECONDS,
        _TOTAL_TIMEOUT_SECONDS,
    )
    from explabs.gateway.worker import GatewayWorkerSettings

    worker_deadline = GatewayWorkerSettings(
        worker_id="w", database_url="postgres://x", drain_key="drain"
    ).request_timeout_seconds
    assert worker_deadline < _TOTAL_TIMEOUT_SECONDS
    assert _CONNECT_TIMEOUT_SECONDS < _TOTAL_TIMEOUT_SECONDS


def test_worker_error_bodies_pass_through_verbatim(edge: TestClient) -> None:
    """The worker's own OpenAI-shaped rejections reach the caller unchanged."""
    response = edge.post(
        "/v1/responses",
        content=b'{"model": "m", "input": "hi"}',
        headers={"Authorization": "Bearer xpl_bad_key"},
    )

    assert response.status_code == 401
    error = response.json()["error"]
    assert error["code"] == "invalid_api_key"
    assert error["message"] == "Incorrect API key provided."


def test_unconfigured_worker_url_answers_shaped_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a worker origin the edge fails closed in OpenAI error shape."""
    monkeypatch.delenv(_WORKER_URL_ENV, raising=False)
    with TestClient(create_app(client=FakeSupabaseClient())) as edge:
        response = edge.post(
            "/v1/chat/completions",
            content=b"{}",
            headers={"Authorization": "Bearer xpl_edge_test_key"},
        )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"


def test_edge_minted_failures_wear_the_anthropic_envelope_on_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The edge's own 503/502 on /v1/messages use Anthropic's envelope.

    The worker's rejections pass through untouched, but the two bodies the
    edge itself mints must match the route's protocol or Anthropic SDKs
    surface them as unparseable errors.
    """
    monkeypatch.delenv(_WORKER_URL_ENV, raising=False)
    with TestClient(create_app(client=FakeSupabaseClient())) as edge:
        unconfigured = edge.post(
            "/v1/messages", content=b"{}", headers={"x-api-key": "xpl_edge_test_key"}
        )
    assert unconfigured.status_code == 503
    assert unconfigured.json() == {
        "type": "error",
        "error": {"type": "overloaded_error", "message": "Serving is unavailable"},
    }

    monkeypatch.setenv(_WORKER_URL_ENV, f"http://127.0.0.1:{_unused_port()}")
    with TestClient(create_app(client=FakeSupabaseClient())) as edge:
        dead = edge.post("/v1/messages", content=b"{}", headers={"x-api-key": "xpl_edge_test_key"})
    assert dead.status_code == 502
    assert dead.json() == {
        "type": "error",
        "error": {"type": "api_error", "message": "Serving backend failed"},
    }


def test_unreachable_worker_answers_shaped_502(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dead worker origin becomes a bounded OpenAI-shaped 502."""
    monkeypatch.setenv(_WORKER_URL_ENV, f"http://127.0.0.1:{_unused_port()}")
    with TestClient(create_app(client=FakeSupabaseClient())) as edge:
        response = edge.get("/v1/models", headers={"Authorization": "Bearer xpl_edge_test_key"})

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "backend_unavailable"


def test_messages_path_is_admitted_and_relays_anthropic_headers(edge: TestClient) -> None:
    """POST /v1/messages reaches the worker with Anthropic headers intact.

    Anthropic SDKs authenticate with x-api-key, not Authorization, so the
    edge must admit the path with no bearer at all and relay x-api-key and
    anthropic-version untouched; the worker is the auth authority.
    """
    response = edge.post(
        "/v1/messages",
        content=b'{"model": "m"}',
        headers={"x-api-key": "xpl_edge_test_key", "anthropic-version": "2023-06-01"},
    )

    assert response.status_code == 200
    (seen,) = _WorkerStub.captured
    assert seen.method == "POST"
    assert seen.path == "/v1/messages"
    assert seen.headers["x-api-key"] == "xpl_edge_test_key"
    assert seen.headers["anthropic-version"] == "2023-06-01"
    assert "authorization" not in seen.headers


def test_unlisted_v1_paths_keep_the_deployment_gate_and_fail_closed(
    edge: TestClient,
) -> None:
    """Paths off the proxied trio never reach the worker.

    An anonymous caller answers 401; the deployment credential reaches the
    proxy's fail-closed OpenAI-shaped 404.
    """
    anonymous = edge.post("/v1/embeddings", content=b"{}")
    gated = edge.post(
        "/v1/embeddings",
        content=b"{}",
        headers={"Authorization": f"Bearer {TEST_API_KEY}"},
    )

    assert anonymous.status_code == 401
    assert anonymous.json()["error"]["code"] == "invalid_api_key"
    assert gated.status_code == 404
    assert gated.json()["error"]["code"] == "not_found"
    assert _WorkerStub.captured == []


# -- end to end: official SDK -> edge -> real worker -> loopback provider ------


class _LoopbackProvider(BaseHTTPRequestHandler):
    """Serve a finite OpenAI-compatible SSE completion like a real provider."""

    frame_delay_seconds: ClassVar[float] = 0.0

    def do_POST(self) -> None:
        """Stream text, usage, and terminal frames for one chat dispatch."""
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length))
        assert payload["stream"] is True
        frames = (
            b'data: {"choices": [{"index": 0, "delta": '
            b'{"role": "assistant", "content": "hello "}, "finish_reason": null}]}\n\n',
            b'data: {"choices": [{"index": 0, "delta": {"content": "world"}, '
            b'"finish_reason": "stop"}]}\n\n',
            b'data: {"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 2}}\n\n',
            b"data: [DONE]\n\n",
        )
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for frame in frames:
            if type(self).frame_delay_seconds:
                time.sleep(type(self).frame_delay_seconds)
            self.wfile.write(frame)
            self.wfile.flush()

    def log_message(self, format: str, *args: object) -> None:
        """Suppress request logs so test output cannot retain payload context."""
        del format, args


class _UvicornThread:
    """Serve one ASGI app on a loopback port from a daemon thread."""

    def __init__(self, app: FastAPI, port: int) -> None:
        """Configure the server without starting it.

        Args:
            app: ASGI app to serve.
            port: Loopback port to bind.
        """
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
        )
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self, ready_path: str) -> None:
        """Start serving and wait until the given path answers 200.

        Args:
            ready_path: Absolute URL polled until it answers 200.
        """
        self.thread.start()
        deadline = time.monotonic() + 30
        last_error = ""
        while time.monotonic() < deadline:
            try:
                if httpx.get(ready_path, timeout=2).status_code == 200:
                    return
            except httpx.HTTPError as error:
                last_error = str(error)
            time.sleep(0.1)
        message = f"server never became ready at {ready_path}: {last_error}"
        raise AssertionError(message)

    def stop(self) -> None:
        """Signal shutdown and join the serving thread."""
        self.server.should_exit = True
        self.thread.join(timeout=10)


@pytest.mark.integration
def test_official_sdk_lists_streams_and_fails_auth_through_the_edge(  # noqa: PLR0915 - one sequential end-to-end proof
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The Done-when: the official openai SDK against the edge, end to end.

    Model list, an incrementally streamed chat completion, a streamed
    ``/v1/responses`` run, and the invalid-key 401 all traverse
    edge -> gateway worker -> loopback provider with real sockets.
    """
    from explabs.gateway.conftest import GatewayHarness
    from explabs.gateway.worker import (
        GatewayWorkerSettings,
        compose_gateway_worker_runtime,
        create_gateway_worker_app,
    )

    dsn = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not dsn:
        pytest.skip("SUPABASE_DB_URL is required for integration tests")

    _LoopbackProvider.frame_delay_seconds = 0.25
    provider_port = _unused_port()
    provider = ThreadingHTTPServer(("127.0.0.1", provider_port), _LoopbackProvider)
    provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()

    harness = GatewayHarness(dsn)
    org_id = harness.seed_org()
    key = harness.seed_key(org_id)
    model_id, provider_row_id = str(uuid.uuid4()), str(uuid.uuid4())
    slug = f"gw-int-edge-{uuid.uuid4().hex[:8]}"
    harness.connection.execute(
        """
        insert into public.models (id, slug, display_name, owning_org_id)
        values (%s, %s, 'GW Edge Loopback', %s)
        """,
        (model_id, slug, org_id),
    )
    harness.connection.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, base_url, owning_org_id,
          billing_source, capabilities
        ) values (
          %s, %s, 'local', 'loopback-model', %s, %s, 'customer_managed',
          '{"supports_streaming": true}'::jsonb
        )
        """,
        (provider_row_id, model_id, f"http://127.0.0.1:{provider_port}/v1", org_id),
    )

    settings = GatewayWorkerSettings.model_validate(
        {
            "worker_id": f"worker-edge-int-{uuid.uuid4().hex[:8]}",
            "database_url": dsn,
            "drain_key": f"edge-int-drain-{uuid.uuid4().hex[:8]}",
            "ready_file": str(tmp_path / "gateway-ready"),
            "heartbeat_seconds": 0.5,
            "reconcile_interval_seconds": 60,
            "reconcile_grace_seconds": 30,
            "request_timeout_seconds": 30,
            "drain_timeout_seconds": 10,
        }
    )
    worker = _UvicornThread(
        create_gateway_worker_app(runtime=compose_gateway_worker_runtime(settings)),
        _unused_port(),
    )
    edge_port = _unused_port()
    edge_base = f"http://127.0.0.1:{edge_port}/v1"
    try:
        worker_port = worker.server.config.port
        worker.start(f"http://127.0.0.1:{worker_port}/health/ready")
        monkeypatch.setenv(_WORKER_URL_ENV, f"http://127.0.0.1:{worker_port}")
        edge = _UvicornThread(create_app(client=FakeSupabaseClient()), edge_port)
        try:
            edge.start(f"http://127.0.0.1:{edge_port}/health")
            with OpenAI(api_key=key.raw_key, base_url=edge_base) as sdk:
                listed = [model.id for model in sdk.models.list()]
                assert slug in listed

                arrivals: list[float] = []
                text_parts: list[str] = []
                started = time.monotonic()
                stream = sdk.chat.completions.create(
                    model=slug,
                    messages=[{"role": "user", "content": "hi"}],
                    stream=True,
                )
                for chunk in stream:
                    arrivals.append(time.monotonic() - started)
                    text_parts.extend(
                        choice.delta.content for choice in chunk.choices if choice.delta.content
                    )
                assert "".join(text_parts) == "hello world"
                # The provider spaces frames 0.25s apart; a buffered edge
                # would deliver the first chunk at ~the total elapsed time.
                assert len(arrivals) >= 2
                assert arrivals[0] < arrivals[-1] * 0.7

                events = list(sdk.responses.create(model=slug, input="hi", stream=True))
                event_types = {event.type for event in events}
                assert "response.completed" in event_types
                streamed_text = "".join(
                    event.delta for event in events if event.type == "response.output_text.delta"
                )
                assert streamed_text == "hello world"

            with (
                OpenAI(api_key="xpl_not_a_key", base_url=edge_base) as unauthorized,
                pytest.raises(openai.AuthenticationError),
            ):
                unauthorized.models.list()
        finally:
            edge.stop()
    finally:
        worker.stop()
        provider.shutdown()
        provider.server_close()
        provider_thread.join(timeout=5)
        _cleanup_worker_rows(dsn, settings.worker_id, model_id, slug)
        harness.close()


def _cleanup_worker_rows(dsn: str, worker_id: str, model_id: str, slug: str) -> None:
    """Remove the rows the worker's own catalog refresher registered.

    Args:
        dsn: Integration database URL.
        worker_id: Heartbeat row to remove.
        model_id: Seeded catalog model row.
        slug: Seeded model slug, which the worker activated as an alias.
    """
    import psycopg

    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute("set session_replication_role = replica")
        try:
            connection.execute(
                "delete from public.gateway_workers where worker_id = %s", (worker_id,)
            )
            snapshot_rows = connection.execute(
                """
                select distinct catalog_sha256 from public.gateway_alias_revisions
                 where alias_id in (
                   select alias_id from public.gateway_aliases where alias_name = %s
                 )
                """,
                (slug,),
            ).fetchall()
            connection.execute(
                """
                delete from public.gateway_alias_revisions where alias_id in (
                  select alias_id from public.gateway_aliases where alias_name = %s
                )
                """,
                (slug,),
            )
            connection.execute("delete from public.gateway_aliases where alias_name = %s", (slug,))
            for (catalog_sha256,) in snapshot_rows:
                connection.execute(
                    "delete from public.gateway_catalog_snapshots where catalog_sha256 = %s",
                    (catalog_sha256,),
                )
            connection.execute(
                "delete from public.model_providers where model_id = %s", (model_id,)
            )
            connection.execute("delete from public.models where id = %s", (model_id,))
        finally:
            connection.execute("set session_replication_role = origin")


def test_models_list_cache_returns_body_within_ttl() -> None:
    """A fresh entry is served for the whole TTL window."""
    cache = _ModelsListCache(ttl_seconds=10.0)
    cache.put("k", 200, {"content-type": "application/json"}, b'{"data":[]}', monotonic=100.0)
    assert cache.get("k", monotonic=109.9) == (
        200,
        {"content-type": "application/json"},
        b'{"data":[]}',
    )


def test_models_list_cache_expires_after_ttl() -> None:
    """The entry is gone once the TTL elapses, so a grant change propagates."""
    cache = _ModelsListCache(ttl_seconds=10.0)
    cache.put("k", 200, {"content-type": "application/json"}, b"x", monotonic=100.0)
    assert cache.get("k", monotonic=110.1) is None


def test_models_list_cache_miss_for_unknown_key() -> None:
    """An unseen key is a miss, never a stale other-key body."""
    assert _ModelsListCache().get("nope", monotonic=1.0) is None


def test_models_list_cache_bounds_size() -> None:
    """Past capacity the cache purges rather than growing unbounded."""
    cache = _ModelsListCache(ttl_seconds=10.0, max_entries=2)
    cache.put("a", 200, {"content-type": "application/json"}, b"a", monotonic=100.0)
    cache.put("b", 200, {"content-type": "application/json"}, b"b", monotonic=100.0)
    cache.put("c", 200, {"content-type": "application/json"}, b"c", monotonic=100.0)
    # The newest entry survives; capacity is enforced by dropping older ones.
    assert cache.get("c", monotonic=100.0) == (200, {"content-type": "application/json"}, b"c")
    assert cache.get("a", monotonic=100.0) is None
