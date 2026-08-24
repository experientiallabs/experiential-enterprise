# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Natural-language query over an org's OWN gateway usage aggregates.

This is the "ask your telemetry in plain language" engine behind the Insights
surface. It is deliberately NOT a text-to-SQL bridge: a question is parsed by
a small deterministic classifier into a typed :class:`InsightQuery` — one of a
fixed set of metrics over a fixed set of grouping dimensions and time windows —
and that typed query is answered by reading the SAME tenant usage aggregates
the Telemetry page already serves (the per-(bucket, model, lane) timeseries,
the per-key rollup, and the recent request log). There is no free-form query
string, no arbitrary column access, and no cross-tenant read: the org scope and
the read RPCs are the route's, this module only shapes the answer.

Why deterministic and not an LLM: a v1 that a customer can trust to never
invent a number, never leak another org's data, and never need a provider key
to run in CI beats a cleverer parser. The parse surface is intentionally the
stable contract (``InsightMetric`` by ``InsightDimension`` by window); a richer
LLM front-end can later emit exactly this typed query without changing the
executor or the answer shape.

Every dollar figure is derived from the org's observed token mix and the
ledger's own money columns, split the same way the rest of the usage surface
splits it — charged platform credits plus the attributed, never-charged
pass-through estimate — and is labeled as spend, never as an invoice.
"""

from __future__ import annotations

import re
from collections import Counter
from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from explabs.db.stores.gateway_usage_store import (
    GatewayEventStatus,
    GatewayKeyModelUsageRow,
    GatewayLane,
    GatewayUsageBucketRow,
    GatewayUsageEventRow,
)


class InsightMetric(StrEnum):
    """What a question measures. The stable metric vocabulary."""

    SPEND = "spend"
    REQUESTS = "requests"
    ERRORS = "errors"
    TOKENS = "tokens"


class InsightDimension(StrEnum):
    """How a question groups. ``TOTAL`` is the ungrouped whole-org answer.

    ``PROVIDER`` is answered from the recent request log rather than the
    full-window timeseries, because the timeseries aggregates carry no
    provider — the answer says so in its caveat.
    """

    MODEL = "model"
    PROVIDER = "provider"
    LANE = "lane"
    AGENT = "agent"
    TOTAL = "total"


class InsightUnit(StrEnum):
    """Display unit for an answer's values, so the UI formats them right."""

    USD = "usd"
    COUNT = "count"
    PERCENT = "percent"


class InsightWindow(StrEnum):
    """The time windows a question can scope to (the usage windows)."""

    DAY = "24h"
    WEEK = "7d"
    MONTH = "30d"


class InsightQuery(BaseModel):
    """A parsed question: a typed query over the org's usage aggregates."""

    model_config = ConfigDict(frozen=True)

    metric: InsightMetric
    dimension: InsightDimension
    window: InsightWindow


class InsightAnswerRow(BaseModel):
    """One ranked row of an answer (a model, provider, lane, or agent).

    ``value`` is already in display units (dollars for spend, a percentage
    for error rate, a plain count otherwise); ``detail`` is an optional plain
    annotation the UI renders verbatim (a token split, an error count).
    """

    model_config = ConfigDict(frozen=True)

    label: str
    value: float
    detail: str | None


class InsightAnswer(BaseModel):
    """The answer to a natural-language usage question.

    ``understood`` is false only when the question mapped to no metric at all;
    that answer carries no rows and offers ``examples`` instead. An understood
    question with no matching usage is still ``understood`` — it just carries
    an empty ``rows`` and a headline that says there is nothing yet.
    """

    model_config = ConfigDict(frozen=True)

    understood: bool
    interpretation: str
    headline: str
    metric: InsightMetric | None
    dimension: InsightDimension | None
    window: InsightWindow | None
    unit: InsightUnit | None
    rows: tuple[InsightAnswerRow, ...]
    caveat: str | None
    examples: tuple[str, ...]


# The questions the surface advertises it can answer: shown both as the
# starter chips and as the fallback when a question does not parse. Each one
# exercises a real (metric, dimension) pair the executor supports.
SUPPORTED_QUESTIONS: tuple[str, ...] = (
    "Which model cost me the most last week?",
    "Show my spend by provider this month",
    "What's my error rate by model?",
    "Which agent made the most requests?",
    "How much did I spend in the last 24 hours?",
    "How many tokens did I use last week?",
)

# The rows a provider-grouped answer reads from — the recent request log —
# are a sample, not the whole window; the answer says so.
_PROVIDER_SAMPLE_CAVEAT = (
    "Provider-level answers read your most recent requests, since the usage "
    "rollups are grouped by model, not provider."
)

_WINDOW_PHRASE: dict[InsightWindow, str] = {
    InsightWindow.DAY: "the last 24 hours",
    InsightWindow.WEEK: "the last 7 days",
    InsightWindow.MONTH: "the last 30 days",
}

_DIMENSION_NOUN: dict[InsightDimension, str] = {
    InsightDimension.MODEL: "model",
    InsightDimension.PROVIDER: "provider",
    InsightDimension.LANE: "lane",
    InsightDimension.AGENT: "agent",
    InsightDimension.TOTAL: "total",
}


# --- Parsing -------------------------------------------------------------------
#
# Deterministic keyword classification. Order matters: a more specific signal
# (error, tokens) is checked before a broader one (spend, requests) so
# "error rate" never reads as "requests" just because it counts requests.

# Window cues, most specific first; the default is a week.
_WINDOW_CUES: tuple[tuple[re.Pattern[str], InsightWindow], ...] = (
    (
        re.compile(r"\b(24\s*h(ou)?rs?|24h|today|yesterday|last day|past day|last 24)\b"),
        InsightWindow.DAY,
    ),
    (
        re.compile(r"\b(30\s*days?|30d|last month|past month|this month|last 30)\b"),
        InsightWindow.MONTH,
    ),
    (
        re.compile(r"\b(7\s*days?|7d|last week|past week|this week|last 7|weekly)\b"),
        InsightWindow.WEEK,
    ),
)

_METRIC_CUES: tuple[tuple[re.Pattern[str], InsightMetric], ...] = (
    (
        re.compile(r"\b(error|errors|failed|failing|failure|failures|error rate)\b"),
        InsightMetric.ERRORS,
    ),
    (re.compile(r"\b(token|tokens)\b"), InsightMetric.TOKENS),
    (
        re.compile(
            r"(\bspend\b|\bspent\b|\bcost|\bcosts\b|\bcosting\b|expensive|\$|\bmoney\b|\bbill\b|\bbudget\b)"
        ),
        InsightMetric.SPEND,
    ),
    (
        re.compile(
            r"\b(request|requests|call|calls|traffic|volume|throughput|use|used|using|usage|most active|busiest)\b"
        ),
        InsightMetric.REQUESTS,
    ),
)

_DIMENSION_CUES: tuple[tuple[re.Pattern[str], InsightDimension], ...] = (
    (
        re.compile(r"\b(provider|providers|openai|anthropic|bedrock|gemini|azure|openrouter)\b"),
        InsightDimension.PROVIDER,
    ),
    (re.compile(r"\b(lane|lanes|byok|platform credits|pass.?through)\b"), InsightDimension.LANE),
    (re.compile(r"\b(agent|agents|api key|api keys|\bkey\b|\bkeys\b)\b"), InsightDimension.AGENT),
    (re.compile(r"\b(model|models)\b"), InsightDimension.MODEL),
)

# Phrasings that ask for a grouped ranking even without naming a dimension —
# they default to a per-model breakdown.
_GROUPING_CUE = re.compile(
    r"\b(which|what|top|most|highest|biggest|largest|breakdown|per |each|rank|ranked)\b"
)

# Phrasings that ask for one whole-org number.
_TOTAL_CUE = re.compile(r"\b(total|overall|in total|altogether|how much did i|how many did i)\b")


def _parse_window(text: str) -> InsightWindow:
    """First matching window cue, defaulting to a week."""
    for pattern, window in _WINDOW_CUES:
        if pattern.search(text):
            return window
    return InsightWindow.WEEK


def _parse_metric(text: str) -> InsightMetric | None:
    """First matching metric cue in specificity order, or None."""
    for pattern, metric in _METRIC_CUES:
        if pattern.search(text):
            return metric
    return None


def _parse_dimension(text: str) -> InsightDimension:
    """The grouping dimension: an explicit one, else grouped-by-model or total."""
    for pattern, dimension in _DIMENSION_CUES:
        if pattern.search(text):
            return dimension
    if _TOTAL_CUE.search(text):
        return InsightDimension.TOTAL
    if _GROUPING_CUE.search(text):
        return InsightDimension.MODEL
    return InsightDimension.TOTAL


def parse_insight_query(question: str) -> InsightQuery | None:
    """Classify a plain-language question into a typed query.

    Returns None when the question names no metric this engine measures; the
    route turns that into an "I can't answer that yet" answer with examples.
    """
    text = question.strip().lower()
    if not text:
        return None
    metric = _parse_metric(text)
    if metric is None:
        return None
    return InsightQuery(
        metric=metric,
        dimension=_parse_dimension(text),
        window=_parse_window(text),
    )


# --- Aggregation ----------------------------------------------------------------


class _Cell(BaseModel):
    """A running (dimension value) rollup in the ledger's micro-USD units."""

    model_config = ConfigDict(frozen=False)

    request_count: int = 0
    error_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    charged_micro_usd: int = 0
    estimated_micro_usd: int = 0

    def all_spend_micro_usd(self) -> int:
        return self.charged_micro_usd + self.estimated_micro_usd


def _bucket_cells(buckets: tuple[GatewayUsageBucketRow, ...], key: str) -> dict[str, _Cell]:
    """Roll timeseries cells up by ``alias`` (model) or ``lane``."""
    cells: dict[str, _Cell] = {}
    for row in buckets:
        match key:
            case "model":
                label = row.alias or "(unattributed)"
            case "lane":
                label = _lane_label(row.lane)
            case _:  # pragma: no cover - internal callers pass a known key
                label = "all"
        cell = cells.setdefault(label, _Cell())
        cell.request_count += row.request_count
        cell.error_count += row.error_count
        cell.input_tokens += row.input_tokens
        cell.output_tokens += row.output_tokens
        cell.charged_micro_usd += row.cost_micro_usd
        cell.estimated_micro_usd += row.estimated_cost_micro_usd
    return cells


def _provider_cells(events: tuple[GatewayUsageEventRow, ...]) -> dict[str, _Cell]:
    """Roll the recent request log up by provider."""
    cells: dict[str, _Cell] = {}
    for event in events:
        label = event.provider if event.provider is not None else "(undispatched)"
        cell = cells.setdefault(label, _Cell())
        cell.request_count += 1
        if event.status is not GatewayEventStatus.COMPLETED:
            cell.error_count += 1
        cell.input_tokens += event.input_tokens
        cell.output_tokens += event.output_tokens
        cell.charged_micro_usd += event.cost_micro_usd
        cell.estimated_micro_usd += event.estimated_cost_micro_usd
    return cells


def _agent_cells(rows: tuple[GatewayKeyModelUsageRow, ...]) -> dict[str, _Cell]:
    """Roll the per-key usage up by agent (API key).

    Aggregates by the stable ``api_key_id``, never the display label, so two
    keys that happen to share a display name are never merged into one agent.
    The shown label is disambiguated with a short id suffix only when a name
    actually collides across distinct ids.
    """
    by_id: dict[str | None, _Cell] = {}
    labels: dict[str | None, str] = {}
    for row in rows:
        cell = by_id.setdefault(row.api_key_id, _Cell())
        cell.request_count += row.request_count
        cell.error_count += row.error_count
        cell.input_tokens += row.input_tokens
        cell.output_tokens += row.output_tokens
        cell.charged_micro_usd += row.cost_micro_usd
        cell.estimated_micro_usd += row.estimated_cost_micro_usd
        labels[row.api_key_id] = row.key_label or _deleted_key_label(row.api_key_id)
    name_counts = Counter(labels.values())
    cells: dict[str, _Cell] = {}
    for key_id, cell in by_id.items():
        label = labels[key_id]
        # A shared display name across distinct keys would otherwise merge two
        # agents; keep them separate and make the collision legible.
        if key_id is not None and name_counts[label] > 1:
            label = f"{label} ({key_id[:8]})"
        cells[label] = cell
    return cells


def _lane_label(lane: GatewayLane | None) -> str:
    match lane:
        case GatewayLane.PLATFORM_FUNDED:
            return "Platform"
        case GatewayLane.PASS_THROUGH:
            return "BYOK"
        case None:
            return "(undispatched)"


def _deleted_key_label(api_key_id: str | None) -> str:
    """Name for an agent whose key row no longer carries a label."""
    if api_key_id is None:
        return "(deleted key)"
    return f"{api_key_id[:8]} (deleted)"


def _total_cell(cells: dict[str, _Cell]) -> _Cell:
    """Collapse grouped cells into one whole-scope rollup."""
    total = _Cell()
    for cell in cells.values():
        total.request_count += cell.request_count
        total.error_count += cell.error_count
        total.input_tokens += cell.input_tokens
        total.output_tokens += cell.output_tokens
        total.charged_micro_usd += cell.charged_micro_usd
        total.estimated_micro_usd += cell.estimated_micro_usd
    return total


# --- Answer shaping -------------------------------------------------------------


def _usd(micro_usd: int) -> float:
    return round(micro_usd / 1_000_000, 6)


def _spend_row(label: str, cell: _Cell) -> InsightAnswerRow:
    detail = (
        f"incl. ${_usd(cell.estimated_micro_usd):.2f} est. pass-through"
        if cell.estimated_micro_usd > 0
        else None
    )
    return InsightAnswerRow(label=label, value=_usd(cell.all_spend_micro_usd()), detail=detail)


def _requests_row(label: str, cell: _Cell) -> InsightAnswerRow:
    detail = f"{cell.error_count} errors" if cell.error_count > 0 else None
    return InsightAnswerRow(label=label, value=float(cell.request_count), detail=detail)


def _errors_row(label: str, cell: _Cell) -> InsightAnswerRow:
    rate = (cell.error_count / cell.request_count * 100) if cell.request_count > 0 else 0.0
    return InsightAnswerRow(
        label=label,
        value=round(rate, 1),
        detail=f"{cell.error_count} of {cell.request_count}",
    )


def _tokens_row(label: str, cell: _Cell) -> InsightAnswerRow:
    return InsightAnswerRow(
        label=label,
        value=float(cell.input_tokens + cell.output_tokens),
        detail=f"{cell.input_tokens:,} in / {cell.output_tokens:,} out",
    )


def _row_for(metric: InsightMetric, label: str, cell: _Cell) -> InsightAnswerRow:
    match metric:
        case InsightMetric.SPEND:
            return _spend_row(label, cell)
        case InsightMetric.REQUESTS:
            return _requests_row(label, cell)
        case InsightMetric.ERRORS:
            return _errors_row(label, cell)
        case InsightMetric.TOKENS:
            return _tokens_row(label, cell)


def _unit_for(metric: InsightMetric) -> InsightUnit:
    match metric:
        case InsightMetric.SPEND:
            return InsightUnit.USD
        case InsightMetric.ERRORS:
            return InsightUnit.PERCENT
        case InsightMetric.REQUESTS | InsightMetric.TOKENS:
            return InsightUnit.COUNT


def _cells_for_dimension(
    dimension: InsightDimension,
    buckets: tuple[GatewayUsageBucketRow, ...],
    events: tuple[GatewayUsageEventRow, ...],
    by_key: tuple[GatewayKeyModelUsageRow, ...],
) -> dict[str, _Cell]:
    match dimension:
        case InsightDimension.MODEL | InsightDimension.TOTAL:
            return _bucket_cells(buckets, "model")
        case InsightDimension.LANE:
            return _bucket_cells(buckets, "lane")
        case InsightDimension.PROVIDER:
            return _provider_cells(events)
        case InsightDimension.AGENT:
            return _agent_cells(by_key)


def _format_value(metric: InsightMetric, value: float) -> str:
    match metric:
        case InsightMetric.SPEND:
            return f"${value:,.2f}"
        case InsightMetric.ERRORS:
            return f"{value:.1f}%"
        case InsightMetric.REQUESTS:
            return f"{int(value):,} requests"
        case InsightMetric.TOKENS:
            return f"{int(value):,} tokens"


def _total_headline(metric: InsightMetric, cell: _Cell, window: InsightWindow) -> str:
    phrase = _WINDOW_PHRASE[window]
    match metric:
        case InsightMetric.SPEND:
            tail = (
                f" (incl. ${_usd(cell.estimated_micro_usd):.2f} estimated pass-through)"
                if cell.estimated_micro_usd > 0
                else ""
            )
            return f"You spent ${_usd(cell.all_spend_micro_usd()):,.2f} over {phrase}{tail}."
        case InsightMetric.REQUESTS:
            return f"You made {cell.request_count:,} requests over {phrase}."
        case InsightMetric.ERRORS:
            rate = (cell.error_count / cell.request_count * 100) if cell.request_count > 0 else 0.0
            return (
                f"Your overall error rate over {phrase} was {rate:.1f}% "
                f"({cell.error_count:,} of {cell.request_count:,} requests)."
            )
        case InsightMetric.TOKENS:
            total = cell.input_tokens + cell.output_tokens
            return (
                f"You used {total:,} tokens over {phrase} "
                f"({cell.input_tokens:,} in / {cell.output_tokens:,} out)."
            )


def _grouped_headline(
    metric: InsightMetric, dimension: InsightDimension, top: InsightAnswerRow, window: InsightWindow
) -> str:
    phrase = _WINDOW_PHRASE[window]
    noun = _DIMENSION_NOUN[dimension]
    value = _format_value(metric, top.value)
    match metric:
        case InsightMetric.SPEND:
            return f"Your most expensive {noun} over {phrase} was {top.label} at {value}."
        case InsightMetric.REQUESTS:
            return f"Your busiest {noun} over {phrase} was {top.label} with {value}."
        case InsightMetric.ERRORS:
            return (
                f"{top.label} had the highest error rate over {phrase} at {value} ({top.detail})."
            )
        case InsightMetric.TOKENS:
            return f"{top.label} used the most tokens over {phrase}: {value}."


def answer_insight_query(
    query: InsightQuery,
    buckets: tuple[GatewayUsageBucketRow, ...],
    events: tuple[GatewayUsageEventRow, ...],
    by_key: tuple[GatewayKeyModelUsageRow, ...],
) -> InsightAnswer:
    """Answer a parsed query from the org's own usage aggregates.

    Args:
        query: The typed query from :func:`parse_insight_query`.
        buckets: The org's (bucket, model, lane) timeseries for the window.
        events: The org's most recent request rows (the provider-grouping source).
        by_key: The org's per-key rollup for the window (the agent source).

    Returns:
        An answer whose rows and headline are read entirely from the inputs;
        an understood query with no matching usage returns empty rows and a
        "nothing yet" headline rather than a failure.
    """
    unit = _unit_for(query.metric)
    caveat = _PROVIDER_SAMPLE_CAVEAT if query.dimension is InsightDimension.PROVIDER else None
    cells = _cells_for_dimension(query.dimension, buckets, events, by_key)

    if query.dimension is InsightDimension.TOTAL:
        total = _total_cell(cells)
        interpretation = f"{query.metric.value.title()} over {_WINDOW_PHRASE[query.window]}"
        if total.request_count == 0:
            return InsightAnswer(
                understood=True,
                interpretation=interpretation,
                headline=f"You have no usage in {_WINDOW_PHRASE[query.window]} yet.",
                metric=query.metric,
                dimension=query.dimension,
                window=query.window,
                unit=unit,
                rows=(),
                caveat=caveat,
                examples=(),
            )
        return InsightAnswer(
            understood=True,
            interpretation=interpretation,
            headline=_total_headline(query.metric, total, query.window),
            metric=query.metric,
            dimension=query.dimension,
            window=query.window,
            unit=unit,
            rows=(_row_for(query.metric, "Total", total),),
            caveat=caveat,
            examples=(),
        )

    rows = tuple(
        _row_for(query.metric, label, cell)
        for label, cell in cells.items()
        if cell.request_count > 0
    )
    ranked = tuple(sorted(rows, key=lambda row: row.value, reverse=True))
    noun = _DIMENSION_NOUN[query.dimension]
    interpretation = f"{query.metric.value.title()} by {noun} over {_WINDOW_PHRASE[query.window]}"
    if not ranked:
        return InsightAnswer(
            understood=True,
            interpretation=interpretation,
            headline=f"You have no {noun} usage in {_WINDOW_PHRASE[query.window]} yet.",
            metric=query.metric,
            dimension=query.dimension,
            window=query.window,
            unit=unit,
            rows=(),
            caveat=caveat,
            examples=(),
        )
    return InsightAnswer(
        understood=True,
        interpretation=interpretation,
        headline=_grouped_headline(query.metric, query.dimension, ranked[0], query.window),
        metric=query.metric,
        dimension=query.dimension,
        window=query.window,
        unit=unit,
        rows=ranked,
        caveat=caveat,
        examples=(),
    )


def not_understood_answer() -> InsightAnswer:
    """The answer when a question maps to no metric: offer example questions."""
    return InsightAnswer(
        understood=False,
        interpretation="",
        headline=(
            "I can't answer that from your usage yet. Try asking about spend, "
            "requests, errors, or tokens — by model, provider, lane, or agent."
        ),
        metric=None,
        dimension=None,
        window=None,
        unit=None,
        rows=(),
        caveat=None,
        examples=SUPPORTED_QUESTIONS,
    )
