# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the opt-in prompt-capture buffer, serializer, and writer."""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import TYPE_CHECKING, cast

from exp.runtime.gateway.contracts import (
    GatewayApiSurface,
    GatewayMessage,
    GatewayRequest,
)

from explabs.gateway.capture import (
    PromptCaptureBuffer,
    PromptCapturePayload,
    PromptCaptureWriter,
    serialize_capture_messages,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from explabs.gateway.db import GatewayDatabase


def _request(*, system: str = "You are the capture agent.") -> GatewayRequest:
    return GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=(
            GatewayMessage(role="system", content=system),
            GatewayMessage(role="user", content="hello"),
        ),
        stream=False,
    )


def _payload(request_id: str = "request-1") -> PromptCapturePayload:
    return PromptCapturePayload(
        request_id=request_id,
        org_id="00000000-0000-0000-0000-000000000001",
        prompt_sha256="ab" * 32,
        messages_json='[{"role":"user","content":"hi"}]',
    )


def test_serialize_round_trips_the_canonical_messages() -> None:
    """The serialized form is the messages array, roles and content intact."""
    serialized = serialize_capture_messages(_request())
    assert serialized is not None
    messages = json.loads(serialized)
    assert [message["role"] for message in messages] == ["system", "user"]
    assert messages[0]["content"] == "You are the capture agent."


def test_serialize_refuses_oversized_prompts() -> None:
    """A prompt beyond the capture cap serializes to None, never truncated."""
    assert serialize_capture_messages(_request(system="x" * 1_100_000)) is None


def test_buffer_pops_once_and_evicts_oldest() -> None:
    """Pop is collect-and-forget; the cap drops the oldest entries first."""
    buffer = PromptCaptureBuffer(capacity=2)
    buffer.remember(_payload("request-a"))
    buffer.remember(_payload("request-b"))
    buffer.remember(_payload("request-c"))
    assert buffer.pop("request-a") is None
    assert buffer.pop("request-b") is not None
    assert buffer.pop("request-b") is None


class _FakeCursor:
    def __init__(self, calls: list[tuple[str, tuple[object, ...]]]) -> None:
        self._calls = calls

    def execute(self, sql: str, params: tuple[object, ...]) -> None:
        self._calls.append((sql, params))


class _FakeDatabase:
    """Minimal GatewayDatabase double recording writer transactions."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    @contextmanager
    def transaction(self) -> Iterator[_FakeCursor]:
        yield _FakeCursor(self.calls)


def test_writer_persists_via_the_capture_function() -> None:
    """The background writer calls gateway_capture_prompt with the payload."""
    db = _FakeDatabase()
    writer = PromptCaptureWriter(cast("GatewayDatabase", db))
    payload = _payload()
    writer.enqueue(payload)
    assert writer.flush(timeout_seconds=5.0)
    assert len(db.calls) == 1
    sql, params = db.calls[0]
    assert "gateway_capture_prompt" in sql
    assert params == (
        payload.request_id,
        payload.org_id,
        payload.prompt_sha256,
        payload.messages_json,
    )
