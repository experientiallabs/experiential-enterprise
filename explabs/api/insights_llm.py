# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""LLM front-end for the Insights query box: free-form words -> typed query.

The deterministic executor in ``insights_query`` is the safety boundary and
stays unchanged — this module only maps a natural-language question onto the
SAME typed ``InsightQuery`` (metric, dimension, window) the regex parser
emits, exactly the seam that module's docstring reserves for "a richer LLM
front-end". The model receives ONLY the question string (no usage data, no
org identity), must answer through one forced tool call whose schema is the
typed vocabulary, and anything malformed, unanswerable, or slow degrades to
``None`` so the route falls back to the deterministic path. No provider key,
no LLM: ``planner_from_env`` returns ``None`` and the box behaves exactly as
before, which keeps CI and local runs credential-free.

The route's order of attack is deliberate: the regex parser first (fast,
free, covers the advertised phrasings), the LLM only for questions the parser
cannot read, and the "I can't answer that yet" examples answer only when both
give up.
"""

from __future__ import annotations

import functools
import logging
import os
from typing import Protocol, cast

from anthropic import Anthropic
from anthropic.types import ToolParam

from explabs.api.insights_query import (
    InsightDimension,
    InsightMetric,
    InsightQuery,
    InsightWindow,
)

logger = logging.getLogger(__name__)

_API_KEY_ENV = "ANTHROPIC_API_KEY"
_MODEL_ENV = "EXPLABS_INSIGHTS_LLM_MODEL"
_DEFAULT_MODEL = "claude-haiku-4-5-20251001"
_TIMEOUT_SECONDS = 8.0
_MAX_TOKENS = 200

_PLAN_TOOL: dict[str, object] = {
    "name": "plan_usage_query",
    "description": (
        "Map the user's question about their own LLM gateway usage onto one "
        "typed aggregate query. Set answerable=false when the question asks "
        "for anything outside these metrics, dimensions, and windows."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "answerable": {"type": "boolean"},
            "metric": {
                "type": "string",
                "enum": [metric.value for metric in InsightMetric],
                "description": "What is being measured.",
            },
            "dimension": {
                "type": "string",
                "enum": [dimension.value for dimension in InsightDimension],
                "description": (
                    "How to group: model, provider, lane (platform vs BYOK), "
                    "agent (API key), or total."
                ),
            },
            "window": {
                "type": "string",
                "enum": [window.value for window in InsightWindow],
                "description": "Lookback window.",
            },
        },
        "required": ["answerable"],
    },
}

_SYSTEM = (
    "You translate one question about the caller's own LLM gateway usage "
    "into a typed aggregate query via the plan_usage_query tool. Choose the "
    "closest metric/dimension/window; default the window to 7d and the "
    "dimension to total when unstated. Questions about anything other than "
    "this usage data are answerable=false. Never answer in prose."
)


class InsightQueryPlanner(Protocol):
    """Maps one free-form question to a typed query, or None."""

    def plan(self, question: str) -> InsightQuery | None:
        """Return the typed query, or None when unanswerable/unavailable."""
        ...


class AnthropicQueryPlanner:
    """One forced-tool Messages call against a small, fast model."""

    def __init__(self, client: Anthropic, *, model: str) -> None:
        """Bind the client and model id."""
        self._client = client
        self._model = model

    def plan(self, question: str) -> InsightQuery | None:
        """Classify one question; every failure mode degrades to None.

        Args:
            question: The user's words, verbatim; the only content sent.

        Returns:
            The validated typed query, or None (unanswerable, malformed
            output, provider error, timeout).
        """
        try:
            response = self._client.messages.create(
                model=self._model,
                max_tokens=_MAX_TOKENS,
                system=_SYSTEM,
                messages=[{"role": "user", "content": question}],
                # Narrow-boundary cast: the literal matches the SDK's
                # TypedDict shape; the API validates it regardless.
                tools=cast("list[ToolParam]", [_PLAN_TOOL]),
                tool_choice={"type": "tool", "name": "plan_usage_query"},
                timeout=_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: BLE001 - any provider failure means "no plan", never a 500
            logger.warning("insights LLM planner unavailable", exc_info=True)
            return None
        plan = next(
            (
                block.input
                for block in response.content
                if block.type == "tool_use" and block.name == "plan_usage_query"
            ),
            None,
        )
        if not isinstance(plan, dict) or plan.get("answerable") is not True:
            return None
        try:
            return InsightQuery(
                metric=InsightMetric(plan.get("metric")),
                dimension=InsightDimension(plan.get("dimension", InsightDimension.TOTAL.value)),
                window=InsightWindow(plan.get("window", InsightWindow.WEEK.value)),
            )
        except ValueError:
            # An out-of-vocabulary value despite the schema: no plan.
            return None


def planner_from_env(env: dict[str, str] | None = None) -> InsightQueryPlanner | None:
    """Build the planner from the house credential, or None when unset.

    Args:
        env: Environment mapping (tests inject; defaults to ``os.environ``).

    Returns:
        A ready planner, or None so callers keep the deterministic-only path.
    """
    variables = os.environ if env is None else env
    api_key = variables.get(_API_KEY_ENV, "").strip()
    if not api_key:
        return None
    model = variables.get(_MODEL_ENV, "").strip() or _DEFAULT_MODEL
    return AnthropicQueryPlanner(Anthropic(api_key=api_key), model=model)


@functools.cache
def default_planner() -> InsightQueryPlanner | None:
    """The process-wide planner from the deployment env (None = LLM-free)."""
    return planner_from_env()
