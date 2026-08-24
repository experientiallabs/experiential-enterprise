# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the request-timing middleware."""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from explabs.api.request_timing import RequestTimingMiddleware
from explabs.db import query_timing


def _timed_app() -> FastAPI:
    app = FastAPI()

    @app.get("/queries")
    def queries() -> dict[str, bool]:
        query_timing.record_query(lock_wait_ms=1.0, execute_ms=30.0)
        query_timing.record_query(lock_wait_ms=2.0, execute_ms=20.0)
        return {"ok": True}

    @app.get("/plain")
    def plain() -> dict[str, bool]:
        return {"ok": True}

    app.add_middleware(RequestTimingMiddleware)
    return app


def test_server_timing_header_reports_db_totals() -> None:
    """The header carries summed db wire time and the query count."""
    with TestClient(_timed_app()) as client:
        response = client.get("/queries")
    header = response.headers["server-timing"]
    assert "app;dur=" in header
    assert 'db;dur=50.0;desc="2q"' in header
    assert "dbwait;dur=3.0" in header


def test_server_timing_header_present_without_queries() -> None:
    """A query-free route still gets a header with zeroed db metrics."""
    with TestClient(_timed_app()) as client:
        response = client.get("/plain")
    assert 'db;dur=0.0;desc="0q"' in response.headers["server-timing"]


def test_request_log_line_carries_route_and_db_counts(caplog: pytest.LogCaptureFixture) -> None:
    """The post-response log line names the route and its query totals."""
    with (
        caplog.at_level(logging.INFO, logger="explabs.request_timing"),
        TestClient(_timed_app()) as client,
    ):
        client.get("/queries")
    line = next(record.getMessage() for record in caplog.records if "db_n=" in record.getMessage())
    assert 'route="/queries"' in line
    assert "status=200" in line
    assert "db_n=2" in line
    assert "db_ms=50.0" in line


def test_each_request_gets_a_fresh_scope() -> None:
    """Query counts must not accumulate across sequential requests."""
    with TestClient(_timed_app()) as client:
        client.get("/queries")
        response = client.get("/queries")
    assert 'desc="2q"' in response.headers["server-timing"]


def _serving_shaped_app() -> FastAPI:
    app = FastAPI()

    @app.post("/v1/chat/completions")
    def customer_surface() -> dict[str, bool]:
        query_timing.record_query(lock_wait_ms=0.0, execute_ms=10.0)
        return {"ok": True}

    @app.post("/v1/internal")
    def internal_surface(request: Request) -> dict[str, bool]:
        request.state.deployment_key = True
        return {"ok": True}

    app.add_middleware(RequestTimingMiddleware)
    return app


def test_customer_v1_responses_carry_no_timing_header() -> None:
    """Query counts are an internals oracle a customer key must not read."""
    with TestClient(_serving_shaped_app()) as client:
        response = client.post("/v1/chat/completions")
    assert "server-timing" not in response.headers


def test_deployment_credential_sees_timings_on_v1() -> None:
    """The web app, smokes, and operators keep the header everywhere."""
    with TestClient(_serving_shaped_app()) as client:
        response = client.post("/v1/internal")
    assert "server-timing" in response.headers


def _worker_shaped_app(*, timing_header_enabled: bool) -> FastAPI:
    """A gateway-worker-shaped app: fixed header policy, no credential stamp."""
    app = FastAPI()

    @app.post("/v1/chat/completions")
    def customer_surface() -> dict[str, bool]:
        query_timing.record_query(lock_wait_ms=0.0, execute_ms=10.0)
        return {"ok": True}

    @app.get("/health/live")
    def health_live() -> dict[str, bool]:
        return {"ok": True}

    app.add_middleware(RequestTimingMiddleware, timing_header_enabled=timing_header_enabled)
    return app


def test_fixed_policy_enabled_emits_the_header_even_on_v1() -> None:
    """The worker's opt-in flag replaces the deployment-credential gate."""
    with TestClient(_worker_shaped_app(timing_header_enabled=True)) as client:
        response = client.post("/v1/chat/completions")
    assert 'db;dur=10.0;desc="1q"' in response.headers["server-timing"]


def test_fixed_policy_disabled_suppresses_the_header_everywhere() -> None:
    """A production worker leaks no internals, on or off /v1."""
    with TestClient(_worker_shaped_app(timing_header_enabled=False)) as client:
        assert "server-timing" not in client.post("/v1/chat/completions").headers
        assert "server-timing" not in client.get("/health/live").headers


def test_fixed_policy_disabled_still_logs_the_request(caplog: pytest.LogCaptureFixture) -> None:
    """The log line is the observability win; the flag gates only the header."""
    with (
        caplog.at_level(logging.INFO, logger="explabs.request_timing"),
        TestClient(_worker_shaped_app(timing_header_enabled=False)) as client,
    ):
        client.post("/v1/chat/completions")
    line = next(record.getMessage() for record in caplog.records if "db_n=" in record.getMessage())
    assert 'path="/v1/chat/completions"' in line
    assert "db_n=1" in line
