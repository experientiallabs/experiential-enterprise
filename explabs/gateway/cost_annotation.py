# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Additive billed-cost extension on the OpenAI-compatible completion surface.

The base contract is the OpenAI spec, untouched: every field, shape, and
streaming semantic OpenAI defines stays exactly as exp emits it, so an
unmodified OpenAI SDK client parses our responses with zero changes. This
module adds ONE platform extension field on top — ``usage.cost`` (USD float,
the amount actually billed) — on ``/v1/chat/completions`` and
``/v1/responses``: the non-streaming body and the final usage-bearing SSE
frame (``stream_options.include_usage``) alike. (The models-listing ``pricing``
extension lives at the resolver seam instead — see
``OrgAwareRouteResolver.published_metadata`` in explabs/gateway/catalog.py —
because the Rust plane serves ``GET /v1/models`` through that callback and
never through this ASGI layer.)

The value is the SETTLED attempt row's truth, not a recomputation: the pinned
``exp`` runtime assembles response payloads as plain JSON with no
post-processing hook, so ``PostgresAttemptLedger`` reads the row back in the
same settle call (settlement is synchronous and strictly precedes response
assembly in both lanes) and records it here keyed by the response's public id
digest; promo funding, promo discounts, and the zero-completion insurance are
all reflected exactly as billed.

BYOK (``customer_managed``) requests are never charged, so where the field
appears it reports ``cost: 0``; the attributed provider-list cost stays
visible through the usage history surfaces.

Two request classes deliberately carry NO cost field:

* KEYED requests (``Idempotency-Key`` / ``X-Client-Request-Id``): exp's replay
  and continuation contracts return the exact retained bytes, possibly from
  another worker, so an injected field a replay cannot reproduce would break
  byte-exactness. The annotator skips them entirely — deterministic on the
  original and every replay.
* Requests the Rust data plane serves end-to-end (unkeyed single-rung BYOK):
  they never traverse this ASGI seam, until exp exposes a native response
  seam. All platform-funded traffic escalates to the Python engine and is
  covered.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import cast

logger = logging.getLogger(__name__)

# In-flight responses bound the registry; entries for responses the Rust plane
# already emitted (never popped) age out by plain FIFO eviction.
_COST_REGISTRY_CAP = 4096

_MICRO_USD_PER_USD = 1_000_000


def public_response_digest(request_id: str) -> str:
    """Derive the digest exp embeds in every public response id.

    Mirrors ``exp.runtime.openai_protocol.streaming.stable_public_id``: the id
    is ``{prefix}_{sha256(request_id)[:32]}``, so the digest correlates the
    settled attempt with the outgoing body on both surfaces (``chatcmpl_`` and
    ``resp_`` share the digest for one request).
    """
    return hashlib.sha256(request_id.encode()).hexdigest()[:32]


@dataclass(frozen=True)
class SettledCost:
    """One finalized request's billing outcome, read back from the settle."""

    billed_micro_usd: int
    billing_source: str

    def usage_fields(self) -> dict[str, object]:
        """Render the additive usage extension fields (OpenAI shape untouched).

        ``cost`` is what the organization was actually charged in USD:
        ``budget_settled_micro_usd`` for platform-funded traffic (promo-funded
        rows settle it to 0 and discounts are already applied), and 0 for BYOK,
        which is never charged (for ``customer_managed`` rows the settled
        column holds the ATTRIBUTED provider-list value, so it must never be
        presented as a charge).
        """
        if self.billing_source == "customer_managed":
            return {"cost": 0.0}
        return {"cost": self.billed_micro_usd / _MICRO_USD_PER_USD}


class CostRegistry:
    """Bounded settled-cost handoff from the attempt ledger to the annotator.

    The ledger records the finalizing settle's billing outcome BEFORE the
    terminal response bytes exist (exp awaits ``finish_attempt`` ahead of
    assembling the non-streaming body, and buffers a stream's terminal frames
    until after settlement), so a pop at response-write time is race-free.
    Entries are popped by the annotator; responses that never traverse the
    Python seam (Rust-served BYOK) leave entries the FIFO bound evicts.
    """

    def __init__(self, *, capacity: int = _COST_REGISTRY_CAP) -> None:
        """Create an empty registry with a hard FIFO bound."""
        self._capacity = capacity
        self._lock = threading.Lock()
        self._records: dict[str, SettledCost] = {}

    def record(self, *, request_id: str, settled: SettledCost) -> None:
        """Retain one finalized request's billing outcome, evicting overflow."""
        digest = public_response_digest(request_id)
        with self._lock:
            self._records[digest] = settled
            while len(self._records) > self._capacity:
                self._records.pop(next(iter(self._records)))

    def pop(self, digest: str) -> SettledCost | None:
        """Consume the settled cost for one public response id digest."""
        with self._lock:
            return self._records.pop(digest, None)


def annotate_completion_payload(payload: object, registry: CostRegistry) -> bool:
    """Inject settled cost into one decoded completion payload, if it matches.

    Handles every usage-bearing shape exp emits: the non-streaming Chat body
    and final streaming usage chunk (top-level ``id`` + ``usage``), the
    non-streaming Responses envelope (same top level), and the terminal
    Responses SSE events, whose envelope nests under ``response``.

    Returns:
        Whether the payload was modified.
    """
    if not isinstance(payload, dict):
        return False
    holder = cast("dict[str, object]", payload)
    if not isinstance(holder.get("usage"), dict):
        nested = holder.get("response")
        if not isinstance(nested, dict):
            return False
        holder = cast("dict[str, object]", nested)
        if not isinstance(holder.get("usage"), dict):
            return False
    identity = holder.get("id")
    if not isinstance(identity, str) or "_" not in identity:
        return False
    settled = registry.pop(identity.rsplit("_", 1)[-1])
    if settled is None:
        return False
    usage = cast("dict[str, object]", holder["usage"])
    usage.update(settled.usage_fields())
    return True


def _headers_with_content_length(
    headers: list[tuple[bytes, bytes]], length: int
) -> list[tuple[bytes, bytes]]:
    """Return the header list with content-length replaced by ``length``."""
    kept = [(name, value) for name, value in headers if name.lower() != b"content-length"]
    kept.append((b"content-length", str(length).encode()))
    return kept


def _header_value(message: dict[str, object], name: bytes) -> bytes:
    """Extract one lowercase header value from an ASGI response-start message."""
    headers = message.get("headers")
    if not isinstance(headers, list):
        return b""
    for header_name, value in cast("list[tuple[bytes, bytes]]", headers):
        if header_name.lower() == name:
            return value.lower()
    return b""


def _replayable_request(scope: dict[str, object]) -> bool:
    """Whether the request carries a caller-operation (replay) header."""
    headers = scope.get("headers")
    if not isinstance(headers, list):
        return False
    for name, value in cast("list[tuple[bytes, bytes]]", headers):
        if name.lower() in _REPLAYABLE_REQUEST_HEADERS and value.strip():
            return True
    return False


_COST_PATHS = frozenset({"/v1/chat/completions", "/v1/responses"})

# Caller-operation headers make a request REPLAYABLE: exp's idempotency and
# continuation contracts return the exact retained bytes on a replay, possibly
# from another worker, so an injected field the replay cannot reproduce would
# break byte-exactness (e2e S3 pins replay.content == first.content). Keyed
# requests therefore pass through unannotated — deterministically, on the
# original AND every replay.
_REPLAYABLE_REQUEST_HEADERS = (b"idempotency-key", b"x-client-request-id")

# Every usage-bearing frame exp emits contains this literal; ordinary token
# delta frames omit the key entirely, so this is a cheap pre-parse filter (a
# content delta that merely CONTAINS the text parses to a payload without a
# usage object and passes through byte-identical).
_USAGE_MARKER = b'"usage"'


class UsageCostAnnotator:
    """ASGI middleware stamping settled ``usage.cost`` on finished completions.

    Same seam as ``EmailVerificationQuotaMiddleware``: the exp mount owns the
    protocol and this platform layer rewrites specific finished payloads.
    Everything else — other paths, non-200s, unparseable bodies, requests with
    no registry entry — passes through byte-identical. SSE rewriting holds
    back only the current incomplete frame, so token deltas stream through
    with no added buffering.
    """

    def __init__(self, app: object, *, registry: CostRegistry) -> None:
        """Bind the downstream app and the settled-cost handoff."""
        self._app = app
        self._registry = registry

    async def __call__(
        self,
        scope: dict[str, object],
        receive: Callable[[], Awaitable[object]],
        send: Callable[[object], Awaitable[None]],
    ) -> None:
        """Rewrite matching 200 responses; relay everything else untouched."""
        app = cast("Callable[..., Awaitable[None]]", self._app)
        if (
            scope.get("type") != "http"
            or scope.get("path") not in _COST_PATHS
            or _replayable_request(scope)
        ):
            await app(scope, receive, send)
            return
        rewriter = _ResponseRewriter(self, send=send)
        await app(scope, receive, rewriter.send)

    def rewrite_json(self, body: bytes) -> bytes:
        """Annotate one buffered JSON body, returning the original on any miss."""
        try:
            payload = json.loads(body)
        except ValueError:
            return body
        if not annotate_completion_payload(payload, self._registry):
            return body
        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()

    def rewrite_frame(self, frame: bytes) -> bytes:
        """Rewrite one complete SSE frame when it carries the usage payload."""
        if _USAGE_MARKER not in frame:
            return frame
        lines = frame.split(b"\n")
        data_indices = [index for index, line in enumerate(lines) if line.startswith(b"data:")]
        # exp emits exactly one data line per frame; anything else passes through.
        if len(data_indices) != 1:
            return frame
        index = data_indices[0]
        try:
            payload = json.loads(lines[index][len(b"data:") :])
        except ValueError:
            return frame
        if not annotate_completion_payload(payload, self._registry):
            return frame
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        lines[index] = b"data: " + encoded.encode()
        return b"\n".join(lines)


class _ResponseRewriter:
    """Per-response send wrapper: buffer JSON wholly, rewrite SSE per frame."""

    def __init__(
        self,
        annotator: UsageCostAnnotator,
        *,
        send: Callable[[object], Awaitable[None]],
    ) -> None:
        self._annotator = annotator
        self._send = send
        self._start_message: dict[str, object] = {}
        self._json_chunks: list[bytes] = []
        self._json = False
        self._sse = False
        self._sse_buffer = bytearray()

    async def send(self, raw_message: object) -> None:
        """Intercept one outgoing ASGI message."""
        if not isinstance(raw_message, dict):
            await self._send(raw_message)
            return
        message = cast("dict[str, object]", raw_message)
        if message.get("type") == "http.response.start":
            await self._on_start(message)
            return
        if message.get("type") != "http.response.body":
            await self._send(message)
            return
        body = message.get("body", b"")
        body = body if isinstance(body, bytes) else b""
        more_body = bool(message.get("more_body"))
        if self._json:
            await self._on_json_body(body, more_body=more_body)
        elif self._sse:
            await self._on_sse_body(body, more_body=more_body)
        else:
            await self._send(message)

    async def _on_start(self, message: dict[str, object]) -> None:
        """Choose the rewrite mode from the response status and content type."""
        if message.get("status") == 200:
            content_type = _header_value(message, b"content-type")
            if content_type.startswith(b"application/json"):
                # Held back until the buffered body's content-length is known.
                self._json = True
                self._start_message = message
                return
            if content_type.startswith(b"text/event-stream"):
                self._sse = True
        await self._send(message)

    async def _on_json_body(self, body: bytes, *, more_body: bool) -> None:
        """Buffer the whole JSON body, rewrite once, and fix content-length."""
        self._json_chunks.append(body)
        if more_body:
            return
        new_body = self._annotator.rewrite_json(b"".join(self._json_chunks))
        raw_headers = self._start_message.get("headers", [])
        await self._send(
            {
                "type": "http.response.start",
                "status": self._start_message.get("status", 200),
                "headers": _headers_with_content_length(
                    cast("list[tuple[bytes, bytes]]", raw_headers), len(new_body)
                ),
            }
        )
        await self._send({"type": "http.response.body", "body": new_body})

    async def _on_sse_body(self, body: bytes, *, more_body: bool) -> None:
        """Forward every completed SSE frame, rewriting the usage-bearing one.

        Only the trailing partial frame stays buffered until its blank-line
        terminator arrives; on the final body message the remainder flushes
        unmodified (a stream that ends mid-frame is already malformed).
        """
        self._sse_buffer.extend(body)
        final = not more_body
        parts = bytes(self._sse_buffer).split(b"\n\n")
        remainder = parts.pop()
        rewrite = self._annotator.rewrite_frame
        out = b"".join(rewrite(frame) + b"\n\n" for frame in parts)
        self._sse_buffer.clear()
        if final:
            out += remainder
        else:
            self._sse_buffer.extend(remainder)
        if out or final:
            await self._send({"type": "http.response.body", "body": out, "more_body": not final})
