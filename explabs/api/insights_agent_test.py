# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the advice agent loop: explore via tools, submit or say nothing."""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast

from anthropic import Anthropic

from explabs.api.insights_agent import AnthropicAdviceAgent, advice_agent_from_env
from explabs.api.suggestions import SuggestionKind


def _tool_use(name: str, payload: object, *, block_id: str = "tu-1") -> object:
    return SimpleNamespace(type="tool_use", name=name, input=payload, id=block_id)


def _response(*blocks: object) -> object:
    return SimpleNamespace(content=list(blocks))


class _ScriptedMessages:
    """Plays back one response per turn and records every request."""

    def __init__(self, responses: list[object]) -> None:
        self._responses = responses
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        return self._responses[len(self.calls) - 1]


def _agent(responses: list[object]) -> tuple[AnthropicAdviceAgent, _ScriptedMessages]:
    messages = _ScriptedMessages(responses)
    client = cast("Anthropic", SimpleNamespace(messages=messages))
    return AnthropicAdviceAgent(client, model="test-model"), messages


_SUBMISSION = {
    "suggestions": [
        {
            "kind": "quality",
            "title": "gpt-test errors cluster on one failure class",
            "body": "9 of 11 failures are provider_internal on gpt-test.",
            "estimated_monthly_savings_usd": None,
            "evidence": ["9 of 11 failed requests carried failure_class=provider_internal."],
        }
    ]
}


def test_agent_explores_tools_then_submits_validated_suggestions() -> None:
    """Tool results feed later turns; the submission maps onto the contract."""
    agent, messages = _agent(
        [
            _response(_tool_use("usage_timeseries", {})),
            _response(_tool_use("submit_suggestions", _SUBMISSION)),
        ]
    )
    reads = {"usage_timeseries": lambda: [{"alias": "gpt-test", "error_count": 11}]}
    suggestions = agent.run(reads)
    assert len(suggestions) == 1
    assert suggestions[0].id == "agent:quality:0"
    assert suggestions[0].kind == SuggestionKind.QUALITY
    # The second turn carried the first tool's serialized result back.
    followup = cast("list[dict[str, object]]", messages.calls[1]["messages"])
    tool_result = cast("list[dict[str, object]]", followup[-1]["content"])[0]
    assert '"error_count":11' in cast("str", tool_result["content"])


def test_agent_returns_empty_on_prose_malformed_or_provider_error() -> None:
    """No submission, a bad payload, or a dead provider all read as no advice."""
    prose_only, _ = _agent([_response(SimpleNamespace(type="text", text="hmm"))])
    assert prose_only.run({}) == ()
    malformed, _ = _agent(
        [_response(_tool_use("submit_suggestions", {"suggestions": [{"kind": "nope"}]}))]
    )
    assert malformed.run({}) == ()

    class _Erroring:
        def create(self, **kwargs: object) -> object:
            msg = "provider down"
            raise RuntimeError(msg)

    erroring = AnthropicAdviceAgent(
        cast("Anthropic", SimpleNamespace(messages=_Erroring())), model="m"
    )
    assert erroring.run({}) == ()


def test_agent_survives_a_failing_tool_read() -> None:
    """A raising read becomes a tool error the model sees, never a raise."""

    def _broken() -> object:
        msg = "db down"
        raise RuntimeError(msg)

    # The model submits NON-empty advice after the failed read; the run must
    # still degrade to empty — advice from a partial view is never returned.
    agent, messages = _agent(
        [
            _response(_tool_use("usage_timeseries", {})),
            _response(_tool_use("submit_suggestions", _SUBMISSION)),
        ]
    )
    assert agent.run({"usage_timeseries": _broken}) == ()
    followup = cast("list[dict[str, object]]", messages.calls[1]["messages"])
    tool_result = cast("list[dict[str, object]]", followup[-1]["content"])[0]
    assert "temporarily unavailable" in cast("str", tool_result["content"])


def test_agent_terminates_a_wandering_model_at_the_turn_cap() -> None:
    """A model that only ever reads tools ends honestly empty, never loops."""
    endless = [_response(_tool_use("usage_by_key", {}, block_id=f"tu-{i}")) for i in range(20)]
    agent, messages = _agent(endless)
    assert agent.run({"usage_by_key": list}) == ()
    assert len(messages.calls) == 8


def test_agent_from_env_requires_the_house_credential() -> None:
    """No ANTHROPIC_API_KEY means no agent — the endpoint errors cleanly."""
    assert advice_agent_from_env(env={}) is None
    assert advice_agent_from_env(env={"ANTHROPIC_API_KEY": "sk-test"}) is not None
