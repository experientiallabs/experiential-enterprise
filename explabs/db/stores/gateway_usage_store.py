# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Read path over the gateway's canonical usage store.

``gateway_usage_events`` is the per-request usage ledger the gateway's
settlement transaction emits (one row per finished /v1 request; see the
``20260819190000_gateway_runtime.sql`` column contract). This store wraps the
three tenant read RPCs built over it: the per-(bucket, model, lane)
timeseries, the per-key rollup behind the Agents section, and the
keyset-paginated request log.

The ledger is content-free by design: no request or response bodies are ever
persisted, so there is no row-expand detail to fetch — the list row IS the
complete tenant-visible record, attempt count included. Money stays integer
micro-USD end to end here and keeps the ledger's two-column split —
``cost_micro_usd`` is CHARGED platform credits only, ``estimated_cost_micro_usd``
is the attributed never-charged pass-through estimate — so an estimate can
never read as billed money. The API boundary converts for display.
"""

from __future__ import annotations

import threading
import time
from enum import StrEnum
from typing import cast

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject, SupabaseClient, result_rows

# Page size default for the event log; the RPC caps at 200 regardless.
DEFAULT_EVENT_LIST_LIMIT = 50

# The Telemetry dashboard polls the two window aggregates (timeseries + by-key)
# roughly every 5s, and each one re-runs a GROUP BY over the org's raw usage
# events for the whole window. For a high-volume org that is the same expensive
# scan on every poll and every open tab. These aggregates are org-scoped and
# read through the same service-role client, so the result for a given
# (org, window, filters) is identical between calls; a short process-local TTL
# cache collapses the poll storm to at most one aggregation per window per TTL.
# It does not fix the first cold load (the durable fix is a daily rollup table);
# it removes the repeated re-aggregation. TTL is well under a poll-to-poll gap's
# tolerance for a usage dashboard. The key embeds the ``after`` bound, so callers
# must pass one that is stable across polls (the usage routes floor it to a
# quantum wider than this TTL); a per-request bound makes every key unique and
# every read a miss.
_AGG_CACHE_TTL_SECONDS = 10.0
_AGG_CACHE_MAX = 2048


class _AggregationCache:
    """Short-lived process-local cache of window-aggregate results by key."""

    def __init__(
        self, *, ttl_seconds: float = _AGG_CACHE_TTL_SECONDS, max_entries: int = _AGG_CACHE_MAX
    ) -> None:
        """Create one cache bounded in time and size."""
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, tuple[float, object]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, *, monotonic: float) -> object | None:
        """Return a fresh cached value for a key, or None on miss/expiry."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            expires, value = entry
            if monotonic >= expires:
                del self._entries[key]
                return None
            return value

    def put(self, key: str, value: object, *, monotonic: float) -> None:
        """Cache one value under a key, purging expired entries when full."""
        with self._lock:
            if len(self._entries) >= self._max_entries:
                live = {
                    stored: held for stored, held in self._entries.items() if held[0] > monotonic
                }
                self._entries = live if len(live) < self._max_entries else {}
            self._entries[key] = (monotonic + self._ttl_seconds, value)

    def clear(self) -> None:
        """Drop every entry (used to isolate tests)."""
        with self._lock:
            self._entries.clear()


_aggregation_cache = _AggregationCache()


class GatewayLane(StrEnum):
    """Money lane an event settled on (storage vocabulary).

    ``PASS_THROUGH`` rode the customer's own provider key and its cost is an
    attributed estimate that is never charged; ``PLATFORM_FUNDED`` drew down
    platform credits at provider cost. An event with no lane (nothing was
    dispatched) reads as ``None``.
    """

    PASS_THROUGH = "pass_through"
    PLATFORM_FUNDED = "platform_funded"


class GatewayEventStatus(StrEnum):
    """Terminal state of a finished gateway request.

    Mirrors the ``gateway_usage_events.status`` CHECK; a value outside this
    set fails the row at the typed boundary.
    """

    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INCOMPLETE = "incomplete"
    EXPIRED_BEFORE_DISPATCH = "expired_before_dispatch"
    UNKNOWN_AFTER_CRASH = "unknown_after_crash"


class GatewayUsageBucketRow(BaseModel):
    """One (bucket, model alias, lane) cell from ``gateway_usage_timeseries``.

    ``request_count`` counts every finished request in the cell, errors
    included; ``error_count`` is the subset whose terminal state is not
    ``completed``. Tokens and both money columns sum over all counted rows:
    ``cost_micro_usd`` is charged credits, ``estimated_cost_micro_usd`` the
    never-charged pass-through estimate. ``cached_input_tokens`` sums the
    cache reads inside ``input_tokens`` (a subset, never additive; zero for
    rows settled before the ledger carried the split).
    """

    model_config = ConfigDict(frozen=True)

    bucket_start: str
    alias: str
    lane: GatewayLane | None = None
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cost_micro_usd: int
    estimated_cost_micro_usd: int
    cached_input_tokens: int = 0

    @classmethod
    def from_row(cls, row: JsonObject) -> GatewayUsageBucketRow:
        """Parse a timeseries RPC row."""
        return cls.model_validate(dict(row))


class GatewayKeyModelUsageRow(BaseModel):
    """One (API key, model alias) cell from ``gateway_usage_by_key``.

    ``key_label`` joins from ``api_keys`` at read time; the event's key id is
    an attribution snapshot without a foreign key, so a key deleted after
    settlement keeps its history and reads back with a ``None`` label. A
    ``None`` ``api_key_id`` means the key was hard-deleted BEFORE the request
    settled (the request row's key reference set-nulled).
    """

    model_config = ConfigDict(frozen=True)

    api_key_id: str | None = None
    key_label: str | None = None
    alias: str
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cost_micro_usd: int
    estimated_cost_micro_usd: int
    last_used_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> GatewayKeyModelUsageRow:
        """Parse a per-key rollup RPC row."""
        return cls.model_validate(dict(row))


class GatewayProviderUsageRow(BaseModel):
    """One provider cell from ``gateway_usage_by_provider``.

    ``provider`` is the winning attempt's provider, denormalized onto the
    event at settlement; ``None`` groups the requests where nothing was
    dispatched, so they surface honestly instead of vanishing.
    """

    model_config = ConfigDict(frozen=True)

    provider: str | None = None
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cost_micro_usd: int
    estimated_cost_micro_usd: int
    last_used_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> GatewayProviderUsageRow:
        """Parse a per-provider rollup RPC row."""
        return cls.model_validate(dict(row))


class GatewayUsageEventRow(BaseModel):
    """One request-log row from ``list_gateway_usage_events``.

    The complete tenant-visible event: the ledger stores no bodies, so there
    is no deeper detail behind this row. ``provider`` is the winning attempt's
    provider and ``None`` when nothing was dispatched, exactly like ``lane``.
    ``tools_used`` is the distinct tool names the request invoked (names only,
    never arguments), ``None`` when no tool activity was captured — the WMO
    runtime does not yet surface tool names, so this reads ``None`` today.

    ``pricing_known`` is ``False`` only when the winning attempt dispatched
    under an unknown price, so a zero real cost means "unpriced", not "free".
    ``failure_class`` and ``error_message`` carry the sanitized outcome reason
    for a non-``completed`` request (both ``None`` for a completed/incomplete
    request — the ledger exposes no finer finish reason than ``status``); they
    are names/reasons only, never request content. ``ttft_ms`` is the winning
    attempt's dispatch-to-first-token span (time to first token), ``None`` when
    no first token was observed (pre-dispatch failure or a row settled before
    TTFT capture shipped).
    """

    model_config = ConfigDict(frozen=True)

    request_id: str
    # Null = the key was hard-deleted before the request settled.
    api_key_id: str | None = None
    key_label: str | None = None
    alias: str
    provider: str | None = None
    lane: GatewayLane | None = None
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int = 0
    reasoning_tokens: int = 0
    cost_micro_usd: int
    estimated_cost_micro_usd: int
    pricing_known: bool = True
    latency_ms: int | None = None
    status: GatewayEventStatus
    attempt_count: int
    created_at: str
    # Distinct tool names, first-use order; None = not captured (see class doc).
    tools_used: tuple[str, ...] | None = None
    # Sanitized outcome reason; None for a completed/incomplete request.
    failure_class: str | None = None
    error_message: str | None = None
    # Content-free lineage digests (explabs/gateway/lineage.py): requests
    # sharing prompt_sha256 ran the same agent configuration; sharing
    # conversation_sha256 they belong to one conversation. None for rows
    # settled before lineage existed. stable_prefix_chars is the character
    # length of the shared prompt prefix (token counts derived from it are
    # ESTIMATES and must say so).
    prompt_sha256: str | None = None
    conversation_sha256: str | None = None
    stable_prefix_chars: int | None = None
    # Time to first token, ms; None = no first token observed (see class doc).
    ttft_ms: int | None = None

    @classmethod
    def from_row(cls, row: JsonObject) -> GatewayUsageEventRow:
        """Parse an event-log RPC row."""
        return cls.model_validate(dict(row))


class GatewayInsightsGroupBy(StrEnum):
    """Dimension the deep-insights windowed metrics group by.

    Mirrors the ``gateway_insights_metrics`` ``in_group_by`` CHECK; a value
    outside this set is refused at the RPC boundary.
    """

    DAY = "day"
    MODEL = "model"
    PROVIDER = "provider"


class GatewayInsightsMetricRow(BaseModel):
    """One grouped cell from ``gateway_insights_metrics``.

    ``bucket_key`` is an ISO-8601 UTC instant for ``DAY``, the model alias for
    ``MODEL``, or the winning provider (``"(no dispatch)"`` when nothing was
    dispatched) for ``PROVIDER``. ``cache_hit_rate`` is cached input over total
    input (``None`` when no input tokens); ``tokens_per_second`` is completion
    tokens over generation seconds across dispatched rows (``None`` when no row
    was dispatched). The ``avg_*`` durations average over dispatched rows only,
    so a pre-dispatch failure never drags them toward zero. Money keeps the
    ledger's charged/estimated micro-USD split.
    """

    model_config = ConfigDict(frozen=True)

    bucket_key: str
    request_count: int
    completed_count: int
    error_count: int
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int
    cached_input_tokens: int
    cache_hit_rate: float | None = None
    tokens_per_second: float | None = None
    avg_generation_duration_ms: float | None = None
    avg_routing_overhead_ms: float | None = None
    avg_latency_ms: float | None = None
    cost_micro_usd: int
    estimated_cost_micro_usd: int

    @classmethod
    def from_row(cls, row: JsonObject) -> GatewayInsightsMetricRow:
        """Parse a windowed-metrics RPC row."""
        return cls.model_validate(dict(row))


class GatewayTokensPerSecondRow(BaseModel):
    """One time bucket from ``gateway_insights_tokens_per_second``.

    ``tokens_per_second`` is the bucket's completion tokens over its generation
    seconds. Only dispatched requests (a non-null generation duration) enter
    the series, so a bucket with no throughput simply has no row.
    """

    model_config = ConfigDict(frozen=True)

    bucket_start: str
    request_count: int
    completion_tokens: int
    generation_ms: int
    tokens_per_second: float | None = None

    @classmethod
    def from_row(cls, row: JsonObject) -> GatewayTokensPerSecondRow:
        """Parse a tok/s series RPC row."""
        return cls.model_validate(dict(row))


class GatewayTopAppRow(BaseModel):
    """One attribution row from ``gateway_insights_top_apps``.

    The attribution unit is the API key: ``app_label`` is ``api_keys.name``,
    ``None`` when the key was deleted after settlement (the event's key id is a
    snapshot with no foreign key). A ``None`` ``api_key_id`` means the key was
    hard-deleted before the request settled. Header-based app labels
    (HTTP-Referer / X-Title) require a WMO runtime change and are not yet
    surfaced here.
    """

    model_config = ConfigDict(frozen=True)

    api_key_id: str | None = None
    app_label: str | None = None
    request_count: int
    error_count: int
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int
    cost_micro_usd: int
    estimated_cost_micro_usd: int
    last_used_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> GatewayTopAppRow:
        """Parse a top-apps RPC row."""
        return cls.model_validate(dict(row))


class GatewayPromptUsageRow(BaseModel):
    """One (prompt digest, model alias) cell from ``gateway_usage_by_prompt``.

    Rolls up every settled request in the window that shares one stable prompt
    prefix (system/developer messages + tool declarations) on one alias.
    ``conversation_count`` counts distinct conversations inside the group and
    ``agent_count`` distinct API keys; ``stable_prefix_chars`` is the prefix's
    character length (identical across the group by construction). Rows whose
    lineage predates the feature never appear here.
    """

    model_config = ConfigDict(frozen=True)

    prompt_sha256: str
    alias: str
    request_count: int
    error_count: int
    conversation_count: int
    agent_count: int
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    cost_micro_usd: int
    estimated_cost_micro_usd: int
    stable_prefix_chars: int
    last_used_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> GatewayPromptUsageRow:
        """Parse a per-prompt rollup RPC row."""
        return cls.model_validate(dict(row))


class GatewayUsageStore:
    """Read the gateway usage ledger's tenant aggregates and event log."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client.
        """
        self._client = client

    def usage_timeseries(
        self,
        org_id: str,
        *,
        after: str | None = None,
        bucket_seconds: int = 86_400,
        alias: str | None = None,
        api_key_id: str | None = None,
        lane: GatewayLane | None = None,
    ) -> tuple[GatewayUsageBucketRow, ...]:
        """Bucket org-wide usage per (model alias, lane), ascending time order.

        Args:
            org_id: Owning organization identifier.
            after: Inclusive lower bound on the event settlement time.
            bucket_seconds: Bucket width in seconds.
            alias: Restrict to one model alias.
            api_key_id: Restrict to one API key.
            lane: Restrict to one money lane.

        Returns:
            Non-empty (bucket, alias, lane) cells.
        """
        lane_value = lane.value if lane is not None else None
        cache_key = f"ts:{org_id}:{after}:{bucket_seconds}:{alias}:{api_key_id}:{lane_value}"
        now = time.monotonic()
        cached = _aggregation_cache.get(cache_key, monotonic=now)
        if cached is not None:
            return cast("tuple[GatewayUsageBucketRow, ...]", cached)
        result = self._client.rpc(
            "gateway_usage_timeseries",
            {
                "in_org": org_id,
                "in_after": after,
                "in_bucket_seconds": bucket_seconds,
                "in_alias": alias,
                "in_api_key_id": api_key_id,
                "in_lane": lane_value,
            },
        ).execute()
        rows = tuple(GatewayUsageBucketRow.from_row(row) for row in result_rows(result))
        _aggregation_cache.put(cache_key, rows, monotonic=now)
        return rows

    def usage_by_key(
        self,
        org_id: str,
        *,
        after: str | None = None,
    ) -> tuple[GatewayKeyModelUsageRow, ...]:
        """Roll up a window per (API key, model alias).

        Args:
            org_id: Owning organization identifier.
            after: Inclusive lower bound on the event settlement time.

        Returns:
            One row per (key, alias) with traffic in the window.
        """
        cache_key = f"bykey:{org_id}:{after}"
        now = time.monotonic()
        cached = _aggregation_cache.get(cache_key, monotonic=now)
        if cached is not None:
            return cast("tuple[GatewayKeyModelUsageRow, ...]", cached)
        result = self._client.rpc(
            "gateway_usage_by_key",
            {"in_org": org_id, "in_after": after},
        ).execute()
        rows = tuple(GatewayKeyModelUsageRow.from_row(row) for row in result_rows(result))
        _aggregation_cache.put(cache_key, rows, monotonic=now)
        return rows

    def usage_by_provider(
        self,
        org_id: str,
        *,
        after: str | None = None,
    ) -> tuple[GatewayProviderUsageRow, ...]:
        """Roll up a window per provider ("platform").

        Args:
            org_id: Owning organization identifier.
            after: Inclusive lower bound on the event settlement time.

        Returns:
            One row per provider with traffic in the window, the
            nothing-was-dispatched group included under ``None``.
        """
        result = self._client.rpc(
            "gateway_usage_by_provider",
            {"in_org": org_id, "in_after": after},
        ).execute()
        return tuple(GatewayProviderUsageRow.from_row(row) for row in result_rows(result))

    def usage_by_prompt(
        self,
        org_id: str,
        *,
        after: str | None = None,
    ) -> tuple[GatewayPromptUsageRow, ...]:
        """Roll up a window per (stable prompt prefix, model alias).

        Args:
            org_id: Owning organization identifier.
            after: Inclusive lower bound on the event settlement time.

        Returns:
            One row per (prompt digest, alias) with lineage-bearing traffic in
            the window, busiest first.
        """
        cache_key = f"byprompt:{org_id}:{after}"
        now = time.monotonic()
        cached = _aggregation_cache.get(cache_key, monotonic=now)
        if cached is not None:
            return cast("tuple[GatewayPromptUsageRow, ...]", cached)
        result = self._client.rpc(
            "gateway_usage_by_prompt",
            {"in_org": org_id, "in_after": after},
        ).execute()
        rows = tuple(GatewayPromptUsageRow.from_row(row) for row in result_rows(result))
        _aggregation_cache.put(cache_key, rows, monotonic=now)
        return rows

    def list_events(
        self,
        org_id: str,
        *,
        after: str | None = None,
        before: str | None = None,
        alias: str | None = None,
        api_key_id: str | None = None,
        lane: GatewayLane | None = None,
        status: str | None = None,
        cursor_ts: str | None = None,
        cursor_id: str | None = None,
        limit: int = DEFAULT_EVENT_LIST_LIMIT,
    ) -> tuple[GatewayUsageEventRow, ...]:
        """List usage events newest first with keyset pagination.

        Args:
            org_id: Owning organization identifier.
            after: Inclusive lower bound on the event settlement time.
            before: Exclusive upper bound on the event settlement time.
            alias: Restrict to one model alias.
            api_key_id: Restrict to one API key.
            lane: Restrict to one money lane.
            status: Restrict to one terminal state, or ``"error"`` for every
                terminal state other than ``completed``.
            cursor_ts: ``created_at`` of the last row of the previous page.
            cursor_id: ``request_id`` of the last row of the previous page.
            limit: Page size (the RPC caps at 200).

        Returns:
            Matching events, newest first.
        """
        result = self._client.rpc(
            "list_gateway_usage_events",
            {
                "in_org": org_id,
                "in_after": after,
                "in_before": before,
                "in_alias": alias,
                "in_api_key_id": api_key_id,
                "in_lane": lane.value if lane is not None else None,
                "in_status": status,
                "in_cursor_ts": cursor_ts,
                "in_cursor_id": cursor_id,
                "in_limit": limit,
            },
        ).execute()
        return tuple(GatewayUsageEventRow.from_row(row) for row in result_rows(result))

    def insights_metrics(
        self,
        org_id: str,
        *,
        group_by: GatewayInsightsGroupBy,
        after: str | None = None,
        before: str | None = None,
        bucket_seconds: int = 86_400,
    ) -> tuple[GatewayInsightsMetricRow, ...]:
        """Group deep telemetry into windowed cells by day, model, or provider.

        Args:
            org_id: Owning organization identifier.
            group_by: Grouping dimension.
            after: Inclusive lower bound on the event settlement time.
            before: Exclusive upper bound on the event settlement time.
            bucket_seconds: Bucket width for ``DAY`` grouping (ignored otherwise).

        Returns:
            One cell per group, ascending by ``bucket_key``.
        """
        result = self._client.rpc(
            "gateway_insights_metrics",
            {
                "in_org": org_id,
                "in_group_by": group_by.value,
                "in_after": after,
                "in_before": before,
                "in_bucket_seconds": bucket_seconds,
            },
        ).execute()
        return tuple(GatewayInsightsMetricRow.from_row(row) for row in result_rows(result))

    def insights_tokens_per_second(
        self,
        org_id: str,
        *,
        after: str | None = None,
        before: str | None = None,
        bucket_seconds: int = 3_600,
        alias: str | None = None,
        provider: str | None = None,
    ) -> tuple[GatewayTokensPerSecondRow, ...]:
        """Chart tokens/second over time, one point per bucket.

        Args:
            org_id: Owning organization identifier.
            after: Inclusive lower bound on the event settlement time.
            before: Exclusive upper bound on the event settlement time.
            bucket_seconds: Bucket width in seconds.
            alias: Restrict to one model alias.
            provider: Restrict to one winning provider.

        Returns:
            Buckets that carried dispatched throughput, ascending in time.
        """
        result = self._client.rpc(
            "gateway_insights_tokens_per_second",
            {
                "in_org": org_id,
                "in_after": after,
                "in_before": before,
                "in_bucket_seconds": bucket_seconds,
                "in_alias": alias,
                "in_provider": provider,
            },
        ).execute()
        return tuple(GatewayTokensPerSecondRow.from_row(row) for row in result_rows(result))

    def insights_top_apps(
        self,
        org_id: str,
        *,
        after: str | None = None,
        before: str | None = None,
        limit: int = 20,
    ) -> tuple[GatewayTopAppRow, ...]:
        """Rank attribution keys by traffic over a window.

        Args:
            org_id: Owning organization identifier.
            after: Inclusive lower bound on the event settlement time.
            before: Exclusive upper bound on the event settlement time.
            limit: Maximum rows (the RPC caps at 100).

        Returns:
            One row per attribution key, highest traffic first.
        """
        result = self._client.rpc(
            "gateway_insights_top_apps",
            {
                "in_org": org_id,
                "in_after": after,
                "in_before": before,
                "in_limit": limit,
            },
        ).execute()
        return tuple(GatewayTopAppRow.from_row(row) for row in result_rows(result))
