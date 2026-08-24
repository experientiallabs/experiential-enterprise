# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for in-flight control-plane load shedding."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI

from explabs.api.load_shed import (
    DEFAULT_MAX_CONCURRENCY,
    MAX_CONCURRENCY_ENV,
    InFlightLimitMiddleware,
    configured_max_concurrency,
)


class _HeldRoutes:
    """Routes that park in the handler until released, like a slow backend."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self._entered = asyncio.Semaphore(0)

    async def hold(self) -> dict[str, bool]:
        """Register arrival in the handler, then wait to be released."""
        self._entered.release()
        await self.release.wait()
        return {"ok": True}

    async def wait_entered(self, count: int) -> None:
        """Block until ``count`` requests have reached a held handler."""
        for _ in range(count):
            await asyncio.wait_for(self._entered.acquire(), timeout=5)


def _shedding_app(*, limit: int) -> tuple[FastAPI, _HeldRoutes]:
    """An app whose control-plane and /v1 routes both park in the handler."""
    held = _HeldRoutes()
    app = FastAPI()

    @app.get("/api/slow")
    async def slow() -> dict[str, bool]:
        return await held.hold()

    @app.get("/v1/slow")
    async def slow_stream() -> dict[str, bool]:
        return await held.hold()

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/api/boom")
    async def boom() -> dict[str, bool]:
        msg = "handler failed"
        raise RuntimeError(msg)

    app.add_middleware(InFlightLimitMiddleware, limit=limit)
    return app, held


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://shed.test")


async def test_control_plane_sheds_past_the_in_flight_bound() -> None:
    """A request arriving while the bound is saturated gets an immediate 503."""
    app, held = _shedding_app(limit=1)
    async with _client(app) as client:
        in_flight = asyncio.create_task(client.get("/api/slow"))
        await held.wait_entered(1)
        shed = await client.get("/api/orgs")
        assert shed.status_code == 503
        assert shed.headers["retry-after"] == "1"
        assert "shedding load" in shed.json()["detail"]
        held.release.set()
        assert (await in_flight).status_code == 200


async def test_bound_releases_when_the_held_request_completes() -> None:
    """The pod admits again once in-flight work drains."""
    app, held = _shedding_app(limit=1)
    async with _client(app) as client:
        in_flight = asyncio.create_task(client.get("/api/slow"))
        await held.wait_entered(1)
        assert (await client.get("/api/orgs")).status_code == 503
        held.release.set()
        await in_flight
        # 404 (no such route) proves the request reached routing, not the shed.
        assert (await client.get("/api/orgs")).status_code == 404


async def test_probe_paths_are_never_shed() -> None:
    """Shedding /health would turn overload into a probe-driven restart."""
    app, held = _shedding_app(limit=1)
    async with _client(app) as client:
        in_flight = asyncio.create_task(client.get("/api/slow"))
        await held.wait_entered(1)
        assert (await client.get("/health")).status_code == 200
        held.release.set()
        await in_flight


async def test_streaming_data_plane_is_neither_shed_nor_counted() -> None:
    """Concurrent /v1 requests are throughput, not a control-plane queue."""
    app, held = _shedding_app(limit=1)
    async with _client(app) as client:
        streams = [asyncio.create_task(client.get("/v1/slow")) for _ in range(3)]
        await held.wait_entered(3)
        # The /v1 lane consumed none of the bound, so the control plane admits.
        assert (await client.get("/api/orgs")).status_code == 404
        held.release.set()
        for stream in streams:
            assert (await stream).status_code == 200


async def test_failed_request_releases_its_slot() -> None:
    """A handler exception must not leak a permanently consumed slot."""
    app, _held = _shedding_app(limit=1)
    async with _client(app) as client:
        with pytest.raises(RuntimeError, match="handler failed"):
            await client.get("/api/boom")
        assert (await client.get("/api/orgs")).status_code == 404


def test_non_positive_limit_is_rejected() -> None:
    """A disabled bound is expressed by not installing the middleware."""
    with pytest.raises(ValueError, match="must be positive"):
        InFlightLimitMiddleware(FastAPI(), limit=0)


def test_configured_bound_defaults_and_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """The bound reads its deployment knob, defaulting to the shipped value."""
    monkeypatch.delenv(MAX_CONCURRENCY_ENV, raising=False)
    assert configured_max_concurrency() == DEFAULT_MAX_CONCURRENCY
    monkeypatch.setenv(MAX_CONCURRENCY_ENV, "7")
    assert configured_max_concurrency() == 7
    monkeypatch.setenv(MAX_CONCURRENCY_ENV, "0")
    assert configured_max_concurrency() == 0
