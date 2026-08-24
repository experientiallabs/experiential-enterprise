# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Content-free request lineage: which requests share a prompt or conversation.

The ledger is content-free by construction (``gateway_requests.content_retained
= 0``), so grouping "requests born from the same prompt" rides deterministic
digests computed at the ONE platform-owned seam that still sees the canonical
request body — ``PostgresGatewayControlStore._snapshot_from_resolution`` — and
handed in-process to ``PostgresAttemptLedger.accept_request`` through the
bounded tracker below. Only hashes and a character count ever leave this
module; no message content is stored or logged.

Definitions (all deterministic over the canonical ``GatewayRequest``):

* ``prompt_sha256`` — digest of the stable prompt prefix: every
  system/developer message's content in order plus the caller-defined tool
  declarations. Two requests share it when they run the same agent
  configuration, which is exactly the prefix a provider prompt cache can
  serve.
* ``conversation_sha256`` — ``prompt_sha256``'s basis plus the FIRST
  user-message content. Multi-turn agents resend the seed turn verbatim, so
  turns of one conversation group together without any session state. The
  digest is content-derived, so independent sessions that open with an
  IDENTICAL first message merge into one conversation group; consumers that
  count conversations (e.g. the caching workflow's write estimate) must treat
  the count as a lower bound on real sessions.
* ``stable_prefix_chars`` — character length of the stable prefix (system and
  developer contents plus serialized tool declarations). Downstream dollar
  math derives an ESTIMATED token count from it and must label it as such.

Responses-surface continuations (``previous_response_id``) carry only the
delta turn, so their lineage reflects what the caller sent, not the expanded
history; the dominant agent surface (Chat Completions) always resends the
full conversation.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict

from exp.common.core.artifacts import sha256_json
from exp.runtime.gateway.contracts import GatewayRequest
from pydantic import BaseModel, ConfigDict

# Requests that authorize but never reach accept (deadline, downstream raise)
# would otherwise strand entries; the cap bounds worst-case memory and evicts
# oldest-first. 50k entries is hours of headroom at any realistic accept lag.
_TRACKER_CAPACITY = 50_000


class RequestLineage(BaseModel):
    """The content-free lineage digest set for one canonical request."""

    model_config = ConfigDict(frozen=True)

    prompt_sha256: str
    conversation_sha256: str
    stable_prefix_chars: int


def compute_request_lineage(request: GatewayRequest) -> RequestLineage:
    """Derive the lineage digests from one canonical request.

    Args:
        request: The canonical content-bearing request; read only, never
            retained.

    Returns:
        The frozen lineage digest set.
    """
    system_contents = [
        message.content
        for message in request.messages
        if message.role in ("system", "developer") and message.content is not None
    ]
    tool_declarations = [
        {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }
        for tool in request.tools
    ]
    prompt_basis: dict[str, object] = {
        "system": system_contents,
        "tools": tool_declarations,
    }
    first_user = next(
        (
            message.content
            for message in request.messages
            if message.role == "user" and message.content is not None
        ),
        None,
    )
    conversation_basis: dict[str, object] = {
        "prompt": prompt_basis,
        "first_user": first_user,
    }
    tools_chars = (
        len(json.dumps(tool_declarations, separators=(",", ":"), sort_keys=True))
        if tool_declarations
        else 0
    )
    stable_prefix_chars = sum(len(content) for content in system_contents) + tools_chars
    return RequestLineage(
        prompt_sha256=sha256_json(prompt_basis),
        conversation_sha256=sha256_json(conversation_basis),
        stable_prefix_chars=stable_prefix_chars,
    )


class RequestLineageTracker:
    """Bounded in-process handoff from authorize to the ledger's accept.

    The control store computes lineage while the request body is in scope and
    remembers it under the freshly minted ``request_id``; the ledger pops it
    when persisting the accepted request. Both run in the same worker process
    (composed together in ``worker.py``), so this never crosses a process or
    network boundary.
    """

    def __init__(self, *, capacity: int = _TRACKER_CAPACITY) -> None:
        """Create an empty tracker with an oldest-first eviction cap."""
        self._capacity = capacity
        self._entries: OrderedDict[str, RequestLineage] = OrderedDict()
        self._lock = threading.Lock()

    def remember(self, request_id: str, lineage: RequestLineage) -> None:
        """Store one request's lineage until accept collects it."""
        with self._lock:
            self._entries[request_id] = lineage
            self._entries.move_to_end(request_id)
            while len(self._entries) > self._capacity:
                self._entries.popitem(last=False)

    def pop(self, request_id: str) -> RequestLineage | None:
        """Collect and forget one request's lineage; None when never seen."""
        with self._lock:
            return self._entries.pop(request_id, None)

    def peek(self, request_id: str) -> RequestLineage | None:
        """Read one request's lineage WITHOUT consuming it.

        The ledger's deferred fold may fail on one waterfall rung and retry
        on the next; peeking keeps the entry available for that retry, and
        the successful write pops it.
        """
        with self._lock:
            return self._entries.get(request_id)
