# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Agentic advice: an LLM explores the org's usage aggregates with tools.

The deterministic rules in ``suggestions`` stay the always-on, credential-free
baseline; this agent is the on-demand deep pass behind
``POST /orgs/{org}/insights/agent-advice``. It runs a small tool loop against
four READ-ONLY, org-scoped aggregate reads — the same rows the Insights page
already renders, all content-free — and must deliver its findings through one
forced ``submit_suggestions`` call whose schema is the stable ``Suggestion``
contract. Server-side validation caps the count, restricts kinds to the
existing vocabulary, and assigns ids; a model that wanders, stalls, or emits
anything malformed yields an empty result, never a 500 and never invented
rows.

The model sees aggregate numbers only (token counts, dollar figures, digests,
key labels): the ledger stores no request content, so none can leak here.
No provider key configured means ``advice_agent_from_env`` returns ``None``
and the endpoint answers with a clean typed error — CI and local runs stay
credential-free.
"""

from __future__ import annotations

import functools
import json
import logging
import os
from collections.abc import Callable, Mapping
from typing import Protocol, cast

from anthropic import Anthropic
from anthropic.types import MessageParam, ToolParam
from pydantic import BaseModel, ConfigDict, Field

from explabs.api.suggestions import Suggestion, SuggestionKind

# Tool reads return anything JSON-serializable; the loop only serializes it.
type ToolResult = object

logger = logging.getLogger(__name__)

_API_KEY_ENV = "ANTHROPIC_API_KEY"
_MODEL_ENV = "EXPLABS_INSIGHTS_LLM_MODEL"
_DEFAULT_MODEL = "claude-haiku-4-5-20251001"
_TIMEOUT_SECONDS = 30.0
_MAX_TOKENS = 2_000
# Assistant turns, not tool calls: enough to read all four surfaces and
# submit, tight enough that a wandering model terminates quickly.
_MAX_TURNS = 8
_MAX_SUGGESTIONS = 5

_READ_TOOLS: tuple[dict[str, object], ...] = (
    {
        "name": "usage_timeseries",
        "description": (
            "Per (time bucket, model, lane) sums for the window: requests, "
            "errors, input/output/cached tokens, charged and estimated spend "
            "in micro-USD."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "usage_by_key",
        "description": ("Per (API key, model) rollups: which agents drive which traffic."),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "usage_by_prompt",
        "description": (
            "Per repeated-prompt group: requests that resent the same system "
            "prompt and tools, with conversation/agent counts, cached-token "
            "share, and the estimated stable-prefix size."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "recent_requests",
        "description": (
            "The most recent settled requests (content-free): model, tokens, "
            "cost, latency, status, failure class, prompt group."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
)

_SUBMIT_TOOL: dict[str, object] = {
    "name": "submit_suggestions",
    "description": (
        "Deliver the final advice. Call exactly once, after exploring. An "
        "empty list is a valid answer when the data supports nothing new."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "maxItems": _MAX_SUGGESTIONS,
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": [kind.value for kind in SuggestionKind],
                        },
                        "title": {"type": "string", "maxLength": 120},
                        "body": {"type": "string", "maxLength": 600},
                        "estimated_monthly_savings_usd": {
                            "type": ["string", "null"],
                            "pattern": "^-?[0-9]+\\.[0-9]{2}$",
                        },
                        "evidence": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 6,
                            "items": {"type": "string", "maxLength": 300},
                        },
                    },
                    "required": ["kind", "title", "body", "evidence"],
                },
            }
        },
        "required": ["suggestions"],
    },
}

_SYSTEM = (
    "You are the Insights advisor for one organization's LLM gateway usage. "
    "Explore the read-only aggregate tools, then call submit_suggestions "
    "exactly once with at most five suggestions.\n"
    "Rules:\n"
    "- Every number in a title, body, or evidence line must come from tool "
    "results; never invent or extrapolate beyond simple arithmetic you show.\n"
    "- Dollar figures are estimates: show the arithmetic in the evidence and "
    "say 'estimate, not a quote'. Monthly figures scale the window to 30 days.\n"
    "- Money columns are micro-USD (divide by 1,000,000 for dollars). "
    "cost_micro_usd is charged credits; estimated_cost_micro_usd is the "
    "never-charged BYOK estimate; their sum is all-spend.\n"
    "- The deterministic rules already cover: a strictly-cheaper same-family "
    "model for small requests, uncached repeated prompt prefixes, sustained "
    "error rates, and p95 latency over 30s. Only repeat one of those if you "
    "add genuinely new evidence; prefer what they cannot see — cross-model "
    "patterns, per-agent anomalies, error clusters by failure class, spend "
    "concentration, unusual token mixes.\n"
    "- An empty list is better than a stretched finding."
)


class _AgentSuggestion(BaseModel):
    """One agent-proposed suggestion, validated before it becomes contract."""

    model_config = ConfigDict(frozen=True)

    kind: SuggestionKind
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=600)
    estimated_monthly_savings_usd: str | None = Field(default=None, pattern=r"^-?[0-9]+\.[0-9]{2}$")
    evidence: tuple[str, ...] = Field(min_length=1, max_length=6)


class _AgentSubmission(BaseModel):
    """The forced final tool call's payload."""

    model_config = ConfigDict(frozen=True)

    suggestions: tuple[_AgentSuggestion, ...] = Field(max_length=_MAX_SUGGESTIONS)


class AdviceAgent(Protocol):
    """Runs one exploration over pre-bound org-scoped reads."""

    def run(self, reads: Mapping[str, Callable[[], ToolResult]]) -> tuple[Suggestion, ...]:
        """Explore and return validated suggestions (empty on any failure)."""
        ...


class AnthropicAdviceAgent:
    """Tool loop over the Messages API with a forced structured finish."""

    def __init__(self, client: Anthropic, *, model: str) -> None:
        """Bind the client and model id."""
        self._client = client
        self._model = model

    def run(self, reads: Mapping[str, Callable[[], ToolResult]]) -> tuple[Suggestion, ...]:
        """Run the exploration loop.

        Args:
            reads: Tool name -> zero-argument org-scoped aggregate read. Keys
                must match ``_READ_TOOLS`` names; anything else is unreachable
                by construction.

        Returns:
            Validated suggestions in submission order, or empty when the
            model fails to submit, the provider errors, or validation fails.
        """
        # Narrow-boundary casts: these literals match the SDK's TypedDict
        # params exactly; the SDK validates server-side regardless.
        # Any failed read poisons the run: advice computed from a partial view
        # of the org's usage must never be returned as if it were complete, so
        # a submission after a read failure degrades to the empty result.
        read_failed = False
        messages: list[MessageParam] = [
            cast(
                "MessageParam",
                {
                    "role": "user",
                    "content": (
                        "Explore this organization's usage for the current window "
                        "and submit your advice."
                    ),
                },
            )
        ]
        tools = cast("list[ToolParam]", [*_READ_TOOLS, _SUBMIT_TOOL])
        for _ in range(_MAX_TURNS):
            try:
                response = self._client.messages.create(
                    model=self._model,
                    max_tokens=_MAX_TOKENS,
                    system=_SYSTEM,
                    messages=messages,
                    tools=tools,
                    timeout=_TIMEOUT_SECONDS,
                )
            except Exception:  # noqa: BLE001 - provider failure means "no advice", never a 500
                logger.warning("insights advice agent unavailable", exc_info=True)
                return ()
            tool_uses = [block for block in response.content if block.type == "tool_use"]
            submission = next(
                (block for block in tool_uses if block.name == "submit_suggestions"), None
            )
            if submission is not None:
                if read_failed:
                    logger.warning(
                        "insights advice agent submitted after a failed read; "
                        "dropping the partial-view advice"
                    )
                    return ()
                return _validated(submission.input)
            if not tool_uses:
                # Prose without a submission: the loop is over, honestly empty.
                return ()
            messages.append(
                cast("MessageParam", {"role": "assistant", "content": response.content})
            )
            results = []
            for block in tool_uses:
                read = reads.get(block.name)
                if read is None:
                    payload: ToolResult = {"error": "unknown tool"}
                else:
                    try:
                        payload = read()
                    except Exception:  # noqa: BLE001 - a failed read is a tool error, never a 500
                        logger.warning("insights advice agent tool read failed", exc_info=True)
                        read_failed = True
                        payload = {"error": "the read is temporarily unavailable"}
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": _as_text(payload),
                    }
                )
            messages.append(cast("MessageParam", {"role": "user", "content": results}))
        return ()


def _as_text(payload: ToolResult) -> str:
    """Serialize one tool result compactly for the model."""
    return json.dumps(payload, separators=(",", ":"), default=str)


def _validated(raw: object) -> tuple[Suggestion, ...]:
    """Validate the submission into contract suggestions, empty on failure."""
    try:
        submission = _AgentSubmission.model_validate(raw)
    except ValueError:
        logger.warning("insights advice agent submitted a malformed payload")
        return ()
    return tuple(
        Suggestion(
            id=f"agent:{proposal.kind.value}:{index}",
            kind=proposal.kind,
            title=proposal.title,
            body=proposal.body,
            estimated_monthly_savings_usd=proposal.estimated_monthly_savings_usd,
            evidence=proposal.evidence,
        )
        for index, proposal in enumerate(submission.suggestions)
    )


def advice_agent_from_env(env: dict[str, str] | None = None) -> AdviceAgent | None:
    """Build the agent from the house credential, or None when unset.

    Args:
        env: Environment mapping (tests inject; defaults to ``os.environ``).

    Returns:
        A ready agent, or None so the endpoint answers a clean typed error.
    """
    variables = os.environ if env is None else env
    api_key = variables.get(_API_KEY_ENV, "").strip()
    if not api_key:
        return None
    model = variables.get(_MODEL_ENV, "").strip() or _DEFAULT_MODEL
    return AnthropicAdviceAgent(Anthropic(api_key=api_key), model=model)


@functools.cache
def default_advice_agent() -> AdviceAgent | None:
    """The process-wide agent from the deployment env (None = LLM-free)."""
    return advice_agent_from_env()
