# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the LLM query planner: typed plans in, deterministic fallback out."""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast

from anthropic import Anthropic

from explabs.api.insights_llm import (
    AnthropicQueryPlanner,
    planner_from_env,
)
from explabs.api.insights_query import InsightDimension, InsightMetric, InsightWindow


class _FakeMessages:
    def __init__(self, response: object | Exception) -> None:
        self._response = response
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def _client(response: object | Exception) -> tuple[Anthropic, _FakeMessages]:
    messages = _FakeMessages(response)
    return cast("Anthropic", SimpleNamespace(messages=messages)), messages


def _tool_use(payload: dict[str, object]) -> object:
    block = SimpleNamespace(type="tool_use", name="plan_usage_query", input=payload)
    return SimpleNamespace(content=[block])


def test_planner_maps_a_forced_tool_call_onto_the_typed_query() -> None:
    """A well-formed plan becomes the exact typed query the executor runs."""
    client, messages = _client(
        _tool_use({"answerable": True, "metric": "spend", "dimension": "model", "window": "30d"})
    )
    planner = AnthropicQueryPlanner(client, model="test-model")
    query = planner.plan("cuánto gasté por modelo este mes?")
    assert query is not None
    assert (query.metric, query.dimension, query.window) == (
        InsightMetric.SPEND,
        InsightDimension.MODEL,
        InsightWindow.MONTH,
    )
    # The model receives ONLY the question string, never usage data.
    sent = messages.calls[0]["messages"]
    assert sent == [{"role": "user", "content": "cuánto gasté por modelo este mes?"}]


def test_planner_defaults_dimension_and_window_when_unstated() -> None:
    """Omitted grouping and window take the documented defaults."""
    client, _ = _client(_tool_use({"answerable": True, "metric": "tokens"}))
    query = AnthropicQueryPlanner(client, model="test-model").plan("token usage?")
    assert query is not None
    assert (query.dimension, query.window) == (InsightDimension.TOTAL, InsightWindow.WEEK)


def test_planner_degrades_to_none_on_every_failure_mode() -> None:
    """Unanswerable, malformed, out-of-vocabulary, or provider error: None."""
    unanswerable, _ = _client(_tool_use({"answerable": False}))
    assert AnthropicQueryPlanner(unanswerable, model="m").plan("weather?") is None
    malformed, _ = _client(SimpleNamespace(content=[]))
    assert AnthropicQueryPlanner(malformed, model="m").plan("spend?") is None
    out_of_vocab, _ = _client(_tool_use({"answerable": True, "metric": "vibes"}))
    assert AnthropicQueryPlanner(out_of_vocab, model="m").plan("vibes?") is None
    erroring, _ = _client(RuntimeError("provider down"))
    assert AnthropicQueryPlanner(erroring, model="m").plan("spend?") is None


def test_planner_from_env_requires_the_house_credential() -> None:
    """No ANTHROPIC_API_KEY means no planner — the deterministic path only."""
    assert planner_from_env(env={}) is None
    assert planner_from_env(env={"ANTHROPIC_API_KEY": "  "}) is None
    assert planner_from_env(env={"ANTHROPIC_API_KEY": "sk-test"}) is not None
