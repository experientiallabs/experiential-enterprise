# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Opt-in prompt capture: buffer content at authorize, persist off the hot path.

The gateway ledger is content-free by construction and stays that way; this
module is the ONLY worker path that ever handles request content beyond the
in-flight dispatch, and it runs solely for organizations whose admins flipped
``capture_prompt_content`` (Settings -> Observability, mirrored on Insights).

Flow, mirroring the lineage sidecar (``explabs/gateway/lineage.py``):

1. The control store sees the canonical request at authorize. When the
   authenticated key's org captures (the flag rides the authority row), it
   serializes the messages and remembers them here under the minted
   ``request_id``. Orgs that never opted in cost nothing — no serialization,
   no buffering.
2. The ledger's ``accept_request`` pops the buffered payload only AFTER the
   accept persisted, and enqueues it for the background writer — content
   never rides the content-free accept RPC and never costs the dispatch path
   a round trip.
3. The daemon writer calls ``gateway_capture_prompt``, which re-checks the
   org flag inside the transaction (the SQL flag is the correctness gate;
   the worker-side flag is only the performance gate) and enforces the size
   cap. A dropped capture degrades an observability feature, never
   accounting, so writer failures are logged and dropped.

The worker-side flag reads through the authority reuse cache, so a toggle
change reaches a warm worker within that cache's TTL; the SQL re-check means
a stale "on" can never persist content after an admin turned capture off.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from collections import OrderedDict

import psycopg
from exp.runtime.gateway.contracts import GatewayRequest
from pydantic import BaseModel, ConfigDict

from explabs.gateway.db import GatewayDatabase

logger = logging.getLogger(__name__)

# Buffered payloads awaiting accept; small because only capture-on orgs fill
# it and accept follows authorize within the same request task.
_BUFFER_CAPACITY = 5_000

# The SQL function refuses payloads above 1 MiB; skip serializing anything
# obviously beyond it rather than shipping bytes that will be refused.
_MAX_MESSAGES_BYTES = 1_048_576


class PromptCapturePayload(BaseModel):
    """One request's captured content, ready for the background writer."""

    model_config = ConfigDict(frozen=True)

    request_id: str
    org_id: str
    prompt_sha256: str | None
    # Canonical messages serialized to a JSON string (bounded); the writer
    # passes it to Postgres as jsonb.
    messages_json: str


def serialize_capture_messages(request: GatewayRequest) -> str | None:
    """Serialize the canonical messages for capture, or None when oversized.

    Args:
        request: The canonical content-bearing request; read only.

    Returns:
        A compact JSON array of the request's messages, or None when the
        serialized form exceeds the capture size cap.
    """
    payload = json.dumps(
        [message.model_dump(mode="json", exclude_none=True) for message in request.messages],
        separators=(",", ":"),
    )
    if len(payload.encode()) > _MAX_MESSAGES_BYTES:
        return None
    return payload


class PromptCaptureBuffer:
    """Bounded authorize->accept handoff for capture payloads."""

    def __init__(self, *, capacity: int = _BUFFER_CAPACITY) -> None:
        """Create an empty buffer with an oldest-first eviction cap."""
        self._capacity = capacity
        self._entries: OrderedDict[str, PromptCapturePayload] = OrderedDict()
        self._lock = threading.Lock()

    def remember(self, payload: PromptCapturePayload) -> None:
        """Hold one request's capture payload until accept collects it."""
        with self._lock:
            self._entries[payload.request_id] = payload
            self._entries.move_to_end(payload.request_id)
            while len(self._entries) > self._capacity:
                self._entries.popitem(last=False)

    def pop(self, request_id: str) -> PromptCapturePayload | None:
        """Collect and forget one request's payload; None when never seen."""
        with self._lock:
            return self._entries.pop(request_id, None)


class PromptCaptureWriter:
    """Single daemon writer persisting captures off the dispatch hot path."""

    def __init__(self, db: GatewayDatabase) -> None:
        """Bind the worker's shared connection pool."""
        self._db = db
        self._queue: queue.SimpleQueue[PromptCapturePayload] = queue.SimpleQueue()
        self._pending = 0
        self._condition = threading.Condition()
        self._thread: threading.Thread | None = None
        self._thread_lock = threading.Lock()

    def enqueue(self, payload: PromptCapturePayload) -> None:
        """Queue one capture for the background writer."""
        self._ensure_writer()
        with self._condition:
            self._pending += 1
        self._queue.put(payload)

    def _ensure_writer(self) -> None:
        """Start the single background writer once."""
        if self._thread is not None:
            return
        with self._thread_lock:
            if self._thread is not None:
                return
            thread = threading.Thread(
                target=self._drain,
                name="gateway-prompt-capture-writer",
                daemon=True,
            )
            self._thread = thread
            thread.start()

    def _drain(self) -> None:
        """Persist queued captures until process exit (daemon thread)."""
        while True:
            payload = self._queue.get()
            try:
                with self._db.transaction() as cursor:
                    cursor.execute(
                        "select public.gateway_capture_prompt(%s, %s, %s, %s::jsonb)",
                        (
                            payload.request_id,
                            payload.org_id,
                            payload.prompt_sha256,
                            payload.messages_json,
                        ),
                    )
            except psycopg.errors.DatabaseError:
                logger.warning(
                    "prompt capture dropped for request %s", payload.request_id, exc_info=True
                )
            finally:
                with self._condition:
                    self._pending -= 1
                    self._condition.notify_all()

    def flush(self, timeout_seconds: float = 10.0) -> bool:
        """Block until every enqueued capture is written (tests/drain).

        Returns:
            True when the queue drained inside the timeout.
        """
        deadline = time.monotonic() + timeout_seconds
        with self._condition:
            while self._pending > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(timeout=remaining)
        return True
