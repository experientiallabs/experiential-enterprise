# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Transparent /v1 edge proxy streaming to the private gateway workers.

The gateway worker (Experiential's OpenAI-compatible app over platform Postgres) is
the auth, protocol, and replay authority for the public serving surface. The
edge adds no protocol logic: it relays method, path, body bytes, and caller
headers unchanged (sole exception: the Authorization scheme token is
canonicalized to ``Bearer``, see ``_normalized_bearer``), and streams
response bytes back without buffering.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from collections.abc import AsyncIterator, Mapping

import aiohttp
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from explabs.api.openai_errors import openai_error_response

router = APIRouter(prefix="/v1", tags=["serving gateway"])

_WORKER_URL_ENV = "EXPLABS_GATEWAY_WORKER_URL"

_CONNECT_TIMEOUT_SECONDS = 10.0
# Whole-request wall bound, covering the full streamed relay; sized over the
# worker's 600s request deadline with margin so the edge never cuts a long
# streaming completion before the worker's own deadline (and its terminal
# chunk) is reached.
_TOTAL_TIMEOUT_SECONDS = 660.0

# Transport-owned headers that must not be relayed in either direction. The
# caller's Authorization (scheme token canonicalized, credential untouched),
# Idempotency-Key, and X-Client-Request-Id pass through: the worker
# authenticates the bearer itself, and replay and continuation are keyed on
# the caller's own operation identities, so minting fresh ones here would
# defeat them.
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
    }
)


def _error(status: int, message: str, code: str) -> JSONResponse:
    """Return one OpenAI-compatible edge error.

    Args:
        status: HTTP status.
        message: Customer-safe message.
        code: Stable machine code.

    Returns:
        OpenAI-compatible JSON response.
    """
    return openai_error_response(
        status,
        message,
        err_type="invalid_request_error" if status < 500 else "server_error",
        code=code,
    )


def _anthropic_error(status: int, message: str) -> Response:
    """Anthropic-enveloped edge failure for the /v1/messages route.

    The worker's own rejections pass through untouched; this shapes only the
    two failures the edge itself mints (no origin configured, origin dead),
    which would otherwise wear the OpenAI envelope on an Anthropic route.
    """
    error_type = "overloaded_error" if status == 503 else "api_error"
    return JSONResponse(
        {"type": "error", "error": {"type": error_type, "message": message}},
        status_code=status,
    )


def _worker_origin() -> str | None:
    """Return the configured cluster-local worker origin without a trailing slash."""
    value = os.environ.get(_WORKER_URL_ENV, "").strip().rstrip("/")
    return value or None


def _client(request: Request) -> aiohttp.ClientSession:
    """Return the app-owned gateway worker HTTP client.

    aiohttp rather than httpx: this relay is the whole job of the /v1 edge,
    and httpx's per-request model machinery cost ~1ms of the hop under the
    gateway viral ladder; aiohttp's C-backed client cuts that overhead while
    keeping the same pooled keep-alive shape.

    Args:
        request: Gateway request.

    Returns:
        Reused pooled client session.
    """
    existing = getattr(request.app.state, "gateway_worker_http_client", None)
    if existing is not None:
        return existing
    client = aiohttp.ClientSession(
        # sock_connect, not connect: aiohttp's ``connect`` also bounds POOL
        # acquisition, which would 502 queued requests after 10s whenever all
        # slots hold long streams. httpx bounded pool waits by the total (its
        # ``pool`` timeout defaulted to the 660s), so only the TCP connect
        # itself keeps the short bound.
        timeout=aiohttp.ClientTimeout(
            total=_TOTAL_TIMEOUT_SECONDS, sock_connect=_CONNECT_TIMEOUT_SECONDS
        ),
        # Long keepalives on the cluster-local plaintext worker hop: any caller
        # idle longer than a short expiry paid a fresh edge->worker TCP connect
        # on the next request (#420's fix shape; reconnects are pure tax).
        connector=aiohttp.TCPConnector(limit=100, keepalive_timeout=60.0),
        # Transparent relay: the caller's own bytes and headers cross unchanged,
        # so the client must neither advertise encodings the caller did not ask
        # for nor decompress what the worker returns.
        auto_decompress=False,
        skip_auto_headers=("User-Agent", "Accept-Encoding", "Accept"),
    )
    request.app.state.gateway_worker_http_client = client
    request.app.state.owns_gateway_worker_http_client = True
    return client


def _normalized_bearer(value: str) -> str:
    """Canonicalize a bearer Authorization scheme token to exactly ``Bearer``.

    RFC 7235 auth-scheme names are case-insensitive, but the gateway worker
    (upstream, in WMO) matches the ``Bearer `` prefix case-sensitively; the
    edge normalizes per the RFC so a compliant client sending ``bearer`` or
    ``BEARER`` is not rejected upstream. The credential itself is relayed
    untouched, and non-bearer schemes pass through unchanged.

    Args:
        value: The caller's Authorization header value.

    Returns:
        The value with a bearer scheme token spelled ``Bearer``.
    """
    scheme, separator, credential = value.partition(" ")
    if separator and scheme.lower() == "bearer":
        return f"Bearer {credential}"
    return value


def _forwarded_request_headers(request: Request) -> list[tuple[str, str]]:
    """Relay every caller header except transport-owned ones.

    The Authorization scheme token is the one normalization the transparent
    proxy performs (see ``_normalized_bearer``); everything else is verbatim.

    Args:
        request: Public edge request.

    Returns:
        Header pairs for the worker request.
    """
    return [
        (name, _normalized_bearer(value) if name == "authorization" else value)
        for name, value in request.headers.items()
        if name not in _HOP_BY_HOP
    ]


def _forwarded_response_headers(headers: Mapping[str, str]) -> dict[str, str]:
    """Relay every worker response header except transport-owned ones.

    Args:
        headers: Worker response headers.

    Returns:
        Public response headers.
    """
    return {name: value for name, value in headers.items() if name.lower() not in _HOP_BY_HOP}


def _forwarded_raw_response_headers(headers: Mapping[str, str]) -> list[tuple[bytes, bytes]]:
    """Relay worker response headers verbatim, preserving duplicates.

    ``dict``-shaped forwarding keeps only the last value of a repeated header
    (aiohttp's multidict yields each occurrence separately). The streaming
    relay is a transparent proxy, so a worker that ever repeats a header —
    Set-Cookie is the classic — must cross the edge intact; the /v1/models
    cache keeps the dict shape because its stored bodies never carry
    duplicates.

    Args:
        headers: Worker response multidict headers.

    Returns:
        Encoded header pairs in worker order, hop-by-hop entries removed.
    """
    return [
        (name.encode("latin-1"), value.encode("latin-1"))
        for name, value in headers.items()
        if name.lower() not in _HOP_BY_HOP
    ]


async def _relay(response: aiohttp.ClientResponse) -> AsyncIterator[bytes]:
    """Yield response bytes as they arrive and always release the connection.

    Args:
        response: Streaming worker response.

    Yields:
        Raw encoded response chunks.
    """
    try:
        async for chunk in response.content.iter_any():
            yield chunk
        response.release()
    except BaseException:
        # A relay that dies mid-stream (caller hung up, worker reset) must not
        # return a half-read connection to the pool.
        response.close()
        raise


async def _proxy_to_worker(
    request: Request, path: str, *, anthropic_errors: bool = False
) -> Response:
    """Relay one request to the gateway worker and stream its answer back.

    Args:
        request: Public edge request.
        path: Exact worker path, including the ``/v1`` prefix.
        anthropic_errors: Shape the edge's OWN failure bodies (origin missing
            or dead) in Anthropic's envelope instead of OpenAI's.

    Returns:
        The worker's response, streamed unbuffered (SSE included).
    """
    origin = _worker_origin()
    if origin is None:
        if anthropic_errors:
            return _anthropic_error(503, "Serving is unavailable")
        return _error(503, "Serving is unavailable", "service_unavailable")
    # Transparent proxy: forward the query string verbatim too, so any
    # query-controlled option a worker route honors survives the edge.
    target = f"{origin}{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"
    client = _client(request)
    try:
        upstream = await client.request(
            request.method,
            target,
            data=await request.body(),
            headers=_forwarded_request_headers(request),
            allow_redirects=False,
        )
    except (TimeoutError, aiohttp.ClientError):
        if anthropic_errors:
            return _anthropic_error(502, "Serving backend failed")
        return _error(502, "Serving backend failed", "backend_unavailable")
    relayed = StreamingResponse(_relay(upstream), status_code=upstream.status)
    # Raw assignment after construction: Response(headers=...) only accepts a
    # mapping, which would collapse a repeated worker header to its last value.
    relayed.raw_headers = _forwarded_raw_response_headers(upstream.headers)
    return relayed


# /v1/models is a discovery call, not the hot path: the worker rebuilds and
# re-serializes the whole catalog (tens of KB) from its in-memory state on every
# request, and each call pays the edge->worker hop. The list is scoped to the
# caller's key but is otherwise identical between the worker's catalog refreshes,
# so a tight per-key TTL cache at the edge removes both the hop and the
# re-serialization for repeat calls while a grant or catalog change still
# propagates within the TTL. Only 200s are cached; errors and 401s never are.
_MODELS_CACHE_TTL_SECONDS = 10.0
_MODELS_CACHE_MAX = 512


class _ModelsListCache:
    """Short-lived per-key cache of the serialized ``/v1/models`` body."""

    def __init__(
        self,
        *,
        ttl_seconds: float = _MODELS_CACHE_TTL_SECONDS,
        max_entries: int = _MODELS_CACHE_MAX,
    ) -> None:
        """Create one process-local cache bounded in time and size."""
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, tuple[float, int, dict[str, str], bytes]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, *, monotonic: float) -> tuple[int, dict[str, str], bytes] | None:
        """Return a fresh ``(status, headers, body)`` for a key, or None."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            expires, status, headers, body = entry
            if monotonic >= expires:
                del self._entries[key]
                return None
            return status, dict(headers), body

    def put(
        self, key: str, status: int, headers: dict[str, str], body: bytes, *, monotonic: float
    ) -> None:
        """Cache one model-list response (status, forwarded headers, body)."""
        with self._lock:
            if len(self._entries) >= self._max_entries:
                live = {
                    stored: value for stored, value in self._entries.items() if value[0] > monotonic
                }
                self._entries = live if len(live) < self._max_entries else {}
            self._entries[key] = (monotonic + self._ttl_seconds, status, dict(headers), body)

    def clear(self) -> None:
        """Drop every entry (used to isolate tests)."""
        with self._lock:
            self._entries.clear()


_models_list_cache = _ModelsListCache()


def _models_cache_key(request: Request) -> str | None:
    """Per-key cache key: a hash of the bearer, so the raw key never persists."""
    authorization = request.headers.get("authorization", "")
    if not authorization:
        return None
    return hashlib.sha256(authorization.encode()).hexdigest()


@router.get("/models")
async def list_models(request: Request) -> Response:
    """Relay the model list; the worker scopes it to the caller's key.

    Served from a tight per-key TTL cache when warm, so repeat discovery calls
    skip the worker hop and the catalog re-serialization.
    """
    # Only the canonical full list is cached. A paginated/filtered call
    # (any query string) is a different body per request, so it streams
    # straight through the transparent proxy exactly as before.
    cache_key = None if request.url.query else _models_cache_key(request)
    if cache_key is None:
        return await _proxy_to_worker(request, "/v1/models")

    now = time.monotonic()
    cached = _models_list_cache.get(cache_key, monotonic=now)
    if cached is not None:
        status, headers, body = cached
        # Replay the worker's forwarded headers so a warm hit is byte-for-byte
        # what a miss returns, not a header-stripped variant.
        return Response(content=body, status_code=status, headers=headers)

    origin = _worker_origin()
    if origin is None:
        return _error(503, "Serving is unavailable", "service_unavailable")
    client = _client(request)
    try:
        # Buffered (not streamed) so the small body can be cached; the model
        # list is tens of KB, not an SSE stream.
        upstream = await client.request(
            request.method,
            f"{origin}/v1/models",
            data=await request.body(),
            headers=_forwarded_request_headers(request),
            allow_redirects=False,
        )
        body = await upstream.read()
    except (TimeoutError, aiohttp.ClientError):
        return _error(502, "Serving backend failed", "backend_unavailable")
    headers = _forwarded_response_headers(upstream.headers)
    if upstream.status == 200:
        _models_list_cache.put(cache_key, upstream.status, headers, body, monotonic=now)
    return Response(content=body, status_code=upstream.status, headers=headers)


@router.post("/chat/completions")
async def chat_completions(request: Request) -> Response:
    """Relay one Chat Completions request, streamed or buffered."""
    return await _proxy_to_worker(request, "/v1/chat/completions")


@router.post("/responses")
async def responses(request: Request) -> Response:
    """Relay one Responses request, streamed or buffered."""
    return await _proxy_to_worker(request, "/v1/responses")


@router.post("/messages")
async def anthropic_messages(request: Request) -> Response:
    """Relay one Anthropic Messages request, streamed or buffered."""
    return await _proxy_to_worker(request, "/v1/messages", anthropic_errors=True)


@router.post("/messages/count_tokens")
async def anthropic_count_tokens(request: Request) -> Response:
    """Relay the count_tokens probe; the worker refuses it in Anthropic shape."""
    return await _proxy_to_worker(request, "/v1/messages/count_tokens", anthropic_errors=True)


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def unsupported_v1_path(path: str) -> Response:
    """Fail closed for every OpenAI route the gateway does not serve."""
    return _error(404, f"Unsupported serving path: /v1/{path}", "not_found")
