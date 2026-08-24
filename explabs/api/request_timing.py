# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Request timing: Server-Timing header plus a per-request log line.

Both single-uvicorn pods mount this: the api pod behind cross-region
PostgREST, and the gateway worker over its direct psycopg pool. Latency
attribution has to come from the pod itself. This middleware wraps every HTTP
request and reports two views:

- A ``Server-Timing`` response header (``app`` time to first byte, ``db`` wire
  time, ``dbwait`` execute-lock wait, plus the query count), readable from any
  external client without log access.
- One structured log line after the response completes, which additionally
  covers work done after the last byte (releasing the streamed /v1 worker
  relay happens there).

Pure ASGI on purpose: ``BaseHTTPMiddleware`` adds a task group and stream pair
per request, which is measurable overhead on the single-core pod this exists
to diagnose.
"""

from __future__ import annotations

import logging
import time

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from explabs.db import query_timing

logger = logging.getLogger("explabs.request_timing")
# uvicorn configures only its own loggers; without a handler here INFO lines
# would vanish into logging's lastResort WARNING filter. Propagation stays on
# so pytest's caplog (a root handler) still sees the records; the production
# root logger has no handlers, so nothing prints twice.
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)


class RequestTimingMiddleware:
    """Time every HTTP request and attribute its PostgREST round-trips."""

    def __init__(self, app: ASGIApp, *, timing_header_enabled: bool | None = None) -> None:
        """Wrap the downstream ASGI app.

        Args:
            app: The downstream ASGI app.
            timing_header_enabled: Fixed Server-Timing header policy. ``None``
                (the api pod) defers to the per-request deployment-credential
                gate; the gateway worker never stamps that credential, so it
                passes an explicit boolean wired from its environment instead
                (off in production — customers must not read internals). The
                log line is emitted either way.
        """
        self.app = app
        self._timing_header_enabled = timing_header_enabled

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Run one request under a fresh query-timing scope and report it."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        stats = query_timing.begin_recording()
        started = time.perf_counter()
        status_code = 0

        async def send_timed(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                if self._may_emit_header(scope):
                    app_ms = (time.perf_counter() - started) * 1000.0
                    headers = MutableHeaders(scope=message)
                    headers.append("Server-Timing", _server_timing_value(app_ms, stats))
            await send(message)

        try:
            await self.app(scope, receive, send_timed)
        finally:
            total_ms = (time.perf_counter() - started) * 1000.0
            logger.info(
                'method=%s path="%s" route="%s" status=%d dur_ms=%.1f '
                "db_n=%d db_ms=%.1f db_wait_ms=%.1f",
                scope.get("method", "-"),
                scope.get("path", "-"),
                _route_template(scope),
                status_code,
                total_ms,
                stats.calls,
                stats.execute_ms,
                stats.lock_wait_ms,
            )

    def _may_emit_header(self, scope: Scope) -> bool:
        """Resolve the header policy: fixed when configured, per-scope otherwise."""
        if self._timing_header_enabled is not None:
            return self._timing_header_enabled
        return _may_see_timings(scope)


def _may_see_timings(scope: Scope) -> bool:
    """Whether this caller gets the Server-Timing header.

    /v1 is the customer-facing surface: query counts and cache behavior are
    an internals oracle a customer key has no business reading, so only the
    deployment credential (the web app, smokes, operators) sees the header
    there. Everything else (/health, /api) is operator-facing already. The
    auth middleware runs inside this one and stamps the credential on the
    request state before the response starts, so the answer is ready by the
    time headers go out; an unauthenticated /v1 rejection carries no stamp
    and gets no header either.
    """
    if not str(scope.get("path", "")).startswith("/v1/"):
        return True
    state = scope.get("state")
    if not isinstance(state, dict):
        return False
    return bool(state.get("deployment_key"))


def _server_timing_value(app_ms: float, stats: query_timing.QueryStats) -> str:
    """Render the Server-Timing header value for the response-start snapshot."""
    return (
        f"app;dur={app_ms:.1f}, "
        f'db;dur={stats.execute_ms:.1f};desc="{stats.calls}q", '
        f"dbwait;dur={stats.lock_wait_ms:.1f}"
    )


def _route_template(scope: Scope) -> str:
    """Return the matched route's path template, or ``-`` when none matched."""
    route = scope.get("route")
    return getattr(route, "path_format", getattr(route, "path", None)) or "-"
