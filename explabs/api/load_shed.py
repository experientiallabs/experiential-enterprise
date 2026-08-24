# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""In-flight request load shedding for the api pod's control plane.

Incident 2026-08-22: stale planner stats slowed dashboard reads, requests
queued unboundedly in the api pod, and the kernel OOM-killed it — which
amplified the herd. The bound has to be on requests the pod is actually
working on, and it must not touch the two lanes where a held request is
normal rather than overload:

- uvicorn's own ``limit_concurrency`` sheds on OPEN CONNECTIONS
  (``len(self.connections) >= limit or len(self.tasks) >= limit`` in its http
  protocols), so idle ingress-nginx keep-alive sockets and long-lived SSE
  streams consume the budget without doing work. This middleware counts only
  requests between ``http.request`` admission and their final response.
- Once uvicorn is at its limit it answers 503 on EVERY path, including the
  probe paths the hosting platform health-checks the pods on (``/health`` for the api,
  ``/health/ready`` for the gateway worker), so a shedding pod gets restarted
  by its probe — the same capacity loss the shed was meant to avoid. Probe
  paths are never shed here.

The ``/v1`` data plane is also exempt: a chat completion legitimately holds
its request open for up to the worker's 600s deadline, so concurrent streams
are throughput, not a queue, and counting them against a herd bound would shed
customer traffic at normal load. Only the operator-facing control plane
(``/api`` and anything else the pod mounts) is bounded, which is where the
unbounded queue came from.
"""

from __future__ import annotations

import json
import os

from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_CONCURRENCY_ENV = "EXPLABS_API_MAX_CONCURRENCY"

DEFAULT_MAX_CONCURRENCY = 120

# Probe paths across every deployment shape that boots this app: the api's
# ``/health`` and the gateway worker's liveness/readiness pair. Shedding these
# converts overload into a probe-driven restart.
_PROBE_PATHS = frozenset({"/health", "/health/live", "/health/ready"})

_SHED_BODY = json.dumps(
    {"detail": "The API is shedding load; retry shortly."},
).encode()


def configured_max_concurrency() -> int:
    """Read the in-flight control-plane request bound from the environment.

    Returns:
        The configured bound, or ``DEFAULT_MAX_CONCURRENCY`` when unset. A
        non-positive value disables shedding.

    Raises:
        ValueError: If the configured value is not an integer.
    """
    raw = os.environ.get(MAX_CONCURRENCY_ENV, "").strip()
    if not raw:
        return DEFAULT_MAX_CONCURRENCY
    return int(raw)


class InFlightLimitMiddleware:
    """Shed control-plane requests past a bound on in-flight requests.

    Pure ASGI for the same reason as ``RequestTimingMiddleware``:
    ``BaseHTTPMiddleware`` adds a task group and stream pair per request, and
    this wrapper sits on the hot path of a single-core pod.
    """

    def __init__(self, app: ASGIApp, *, limit: int) -> None:
        """Wrap the downstream ASGI app.

        Args:
            app: The downstream ASGI app.
            limit: Maximum concurrent in-flight guarded requests.

        Raises:
            ValueError: If ``limit`` is not positive.
        """
        if limit < 1:
            msg = f"In-flight request limit must be positive: {limit}"
            raise ValueError(msg)
        self.app = app
        self.limit = limit
        self._in_flight = 0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Serve one request, shedding it when the pod is already saturated."""
        if not _is_guarded(scope):
            await self.app(scope, receive, send)
            return
        if self._in_flight >= self.limit:
            await _send_shed_response(send)
            return
        self._in_flight += 1
        try:
            await self.app(scope, receive, send)
        finally:
            self._in_flight -= 1


def _is_guarded(scope: Scope) -> bool:
    """Whether this scope counts against — and can be shed by — the bound."""
    if scope["type"] != "http":
        return False
    path = str(scope.get("path", ""))
    return path not in _PROBE_PATHS and not path.startswith("/v1/") and path != "/v1"


async def _send_shed_response(send: Send) -> None:
    """Answer 503 immediately instead of queueing the request in memory."""
    start: Message = {
        "type": "http.response.start",
        "status": 503,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(_SHED_BODY)).encode()),
            (b"retry-after", b"1"),
        ],
    }
    await send(start)
    await send({"type": "http.response.body", "body": _SHED_BODY})
