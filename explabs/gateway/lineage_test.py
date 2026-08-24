# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for content-free request lineage digests and the accept handoff."""

from __future__ import annotations

from exp.runtime.gateway.contracts import (
    GatewayApiSurface,
    GatewayMessage,
    GatewayRequest,
    GatewayToolDefinition,
)

from explabs.gateway.lineage import (
    RequestLineageTracker,
    compute_request_lineage,
)


def _request(
    *,
    system: str = "You are a support agent.",
    tools: tuple[GatewayToolDefinition, ...] = (),
    turns: tuple[str, ...] = ("Hello",),
) -> GatewayRequest:
    messages = [GatewayMessage(role="system", content=system)]
    for index, turn in enumerate(turns):
        if index > 0:
            messages.append(GatewayMessage(role="assistant", content=f"reply {index}"))
        messages.append(GatewayMessage(role="user", content=turn))
    return GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=tuple(messages),
        tools=tools,
        stream=False,
    )


_TOOL = GatewayToolDefinition(
    name="lookup_order",
    description="Look up one order.",
    parameters={"type": "object", "properties": {"order_id": {"type": "string"}}},
)


def test_same_prompt_and_seed_turn_share_both_digests() -> None:
    """Later turns of one conversation keep both lineage digests stable."""
    first = compute_request_lineage(_request(turns=("Hello",)))
    later = compute_request_lineage(_request(turns=("Hello", "More", "Even more")))
    assert first.prompt_sha256 == later.prompt_sha256
    assert first.conversation_sha256 == later.conversation_sha256


def test_same_prompt_different_conversations_split_on_conversation_only() -> None:
    """Two conversations from one agent share the prompt digest, not the thread."""
    one = compute_request_lineage(_request(turns=("Hello",)))
    two = compute_request_lineage(_request(turns=("Different opener",)))
    assert one.prompt_sha256 == two.prompt_sha256
    assert one.conversation_sha256 != two.conversation_sha256


def test_prompt_digest_covers_system_and_tools() -> None:
    """Changing the system prompt or the tool set changes the prompt digest."""
    base = compute_request_lineage(_request())
    other_system = compute_request_lineage(_request(system="You are a billing agent."))
    with_tool = compute_request_lineage(_request(tools=(_TOOL,)))
    assert base.prompt_sha256 != other_system.prompt_sha256
    assert base.prompt_sha256 != with_tool.prompt_sha256


def test_stable_prefix_chars_counts_system_and_tools_only() -> None:
    """The prefix length ignores conversation turns and grows with tools."""
    short = compute_request_lineage(_request(turns=("Hello",)))
    long_history = compute_request_lineage(_request(turns=("Hello", "a" * 5_000)))
    assert short.stable_prefix_chars == long_history.stable_prefix_chars
    assert short.stable_prefix_chars == len("You are a support agent.")
    with_tool = compute_request_lineage(_request(tools=(_TOOL,)))
    assert with_tool.stable_prefix_chars > short.stable_prefix_chars


def test_tracker_peek_does_not_consume() -> None:
    """Peek serves the deferred fold's retry; pop still clears the entry."""
    tracker = RequestLineageTracker(capacity=4)
    lineage = compute_request_lineage(_request())
    tracker.remember("request-1", lineage)
    assert tracker.peek("request-1") == lineage
    assert tracker.peek("request-1") == lineage
    assert tracker.pop("request-1") == lineage
    assert tracker.peek("request-1") is None


def test_tracker_pops_once_and_evicts_oldest_beyond_capacity() -> None:
    """Pop is collect-and-forget; the cap drops the oldest entries first."""
    tracker = RequestLineageTracker(capacity=2)
    lineage = compute_request_lineage(_request())
    tracker.remember("request-a", lineage)
    tracker.remember("request-b", lineage)
    tracker.remember("request-c", lineage)
    assert tracker.pop("request-a") is None
    assert tracker.pop("request-b") == lineage
    assert tracker.pop("request-b") is None
    assert tracker.pop("request-c") == lineage
