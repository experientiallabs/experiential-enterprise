# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tenant usage routes over the gateway's canonical usage store.

The Telemetry page's primary data source: org-wide usage timeseries, the
per-key ("Agents") rollup, and the per-request log, all read from
``gateway_usage_events`` — the per-request ledger the gateway settlement
transaction emits. The retiring legacy serving lane (``serving_requests``)
is deliberately NOT merged into these responses: its rows keep different
cost semantics and remain readable through the existing ``/serving/*``
routes until that lane is deleted, so no response here ever mixes sources.

API vocabulary: the ledger's ``platform_funded``/``pass_through`` lanes are
exposed as ``"platform"``/``"byok"`` for UI stability, and the ledger's
``alias`` (the model slug customers put in the ``model`` field) is exposed
as ``model``. Money converts from the ledger's integer micro-USD to float
dollars at this boundary and keeps the ledger's split: ``cost_usd`` is
CHARGED platform credits only (zero for pure-BYOK requests) and
``estimated_cost_usd`` is the attributed, never-charged pass-through
estimate. An "all spend" headline is the two added together, but the split
stays visible so an estimate can never read as billed money. It is display
data here, never re-invoiced.

The ledger is content-free by design — request/response bodies are never
persisted — so the request log has no row-expand detail endpoint: each list
row already carries the complete tenant-visible event, attempt count
included.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.credits import load_organization
from explabs.api.insights_agent import default_advice_agent
from explabs.api.insights_llm import default_planner
from explabs.api.insights_query import (
    InsightAnswer,
    answer_insight_query,
    not_understood_answer,
    parse_insight_query,
)
from explabs.api.routes import ApiError, get_supabase
from explabs.api.suggestions import SuggestionsResponse, generate_suggestions
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import JsonObject, SupabaseClient, update_by_id
from explabs.db.stores.gateway_capture_store import GatewayCaptureStore
from explabs.db.stores.gateway_usage_store import (
    GatewayEventStatus,
    GatewayInsightsGroupBy,
    GatewayInsightsMetricRow,
    GatewayKeyModelUsageRow,
    GatewayLane,
    GatewayProviderUsageRow,
    GatewayTokensPerSecondRow,
    GatewayTopAppRow,
    GatewayUsageBucketRow,
    GatewayUsageEventRow,
    GatewayUsageStore,
)

router = APIRouter(prefix="/api", tags=["usage"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

# Window shorthand -> (lookback, bucket width). Identical to the legacy
# Telemetry summary so gateway and legacy charts bucket the same way during
# the transition.
_WINDOWS: dict[str, tuple[timedelta, int]] = {
    "24h": (timedelta(hours=24), 3_600),
    "7d": (timedelta(days=7), 86_400),
    "30d": (timedelta(days=30), 86_400),
}

_DEFAULT_WINDOW = "7d"

# The window's lower bound is floored to this granularity. A microsecond-precise
# "now - lookback" makes every poll a distinct value, and the store's aggregate
# cache keys on it, so an unquantized bound turns that cache into a pure miss
# path (one GROUP BY per poll per tab) instead of one aggregation per window.
# The quantum exceeds the store's cache TTL so a key stays stable for at least
# an entry's lifetime; freshness still comes from the TTL, and a bound coarse by
# under a minute is immaterial to a 24h/7d/30d window.
_WINDOW_QUANTUM_SECONDS = 60

# The list RPC caps at this bound regardless of the requested limit.
_LIST_CAP = 200

# The advice agent's recent-request sample: enough texture for error and
# latency patterns without flooding the context.
_AGENT_EVENT_SAMPLE = 50


class UsageLane(StrEnum):
    """Money lane in API vocabulary.

    ``PLATFORM`` = platform credits at provider cost (the ledger's
    ``platform_funded``); ``BYOK`` = the customer's own provider key, cost
    attributed but never charged (the ledger's ``pass_through``).
    """

    PLATFORM = "platform"
    BYOK = "byok"


def _lane_to_api(lane: GatewayLane | None) -> UsageLane | None:
    """Map a storage lane to API vocabulary (None = nothing was dispatched)."""
    match lane:
        case None:
            return None
        case GatewayLane.PLATFORM_FUNDED:
            return UsageLane.PLATFORM
        case GatewayLane.PASS_THROUGH:
            return UsageLane.BYOK
        case _:
            assert_never(lane)


def _lane_filter_or_400(value: str | None) -> GatewayLane | None:
    """Parse the ``lane`` query parameter into the storage vocabulary."""
    match value:
        case None:
            return None
        case UsageLane.PLATFORM:
            return GatewayLane.PLATFORM_FUNDED
        case UsageLane.BYOK:
            return GatewayLane.PASS_THROUGH
        case _:
            msg = f"Unknown lane: {value} (expected platform or byok)"
            raise ApiError(msg, status_code=400)


def _micro_to_usd(cost_micro_usd: int) -> float:
    """Convert the ledger's integer micro-USD to display dollars."""
    return cost_micro_usd / 1_000_000


def _window(window: str | None) -> tuple[str, str, int]:
    """Resolve a window shorthand to (key, after-timestamp, bucket seconds)."""
    key = window or _DEFAULT_WINDOW
    if key not in _WINDOWS:
        msg = f"Unknown window: {key} (expected one of {', '.join(sorted(_WINDOWS))})"
        raise ApiError(msg, status_code=400)
    lookback, bucket_seconds = _WINDOWS[key]
    after = (_quantized_now() - lookback).isoformat()
    return key, after, bucket_seconds


def _quantized_now() -> datetime:
    """Now, floored to ``_WINDOW_QUANTUM_SECONDS``, so polls share a value."""
    epoch_seconds = int(datetime.now(tz=UTC).timestamp())
    return datetime.fromtimestamp(epoch_seconds - epoch_seconds % _WINDOW_QUANTUM_SECONDS, tz=UTC)


def _uuid_or_400(value: str, name: str) -> str:
    """Reject a malformed uuid at the boundary: Postgres would 22P02 -> 500."""
    try:
        UUID(value)
    except ValueError as error:
        msg = f"Invalid {name}: {value} (expected a uuid)"
        raise ApiError(msg, status_code=400) from error
    return value


def _timestamp_or_400(value: str, name: str) -> str:
    """Reject a malformed timestamp at the boundary for the same reason."""
    try:
        datetime.fromisoformat(value)
    except ValueError as error:
        msg = f"Invalid {name}: {value} (expected an ISO 8601 timestamp)"
        raise ApiError(msg, status_code=400) from error
    return value


def _status_or_400(value: str | None) -> str | None:
    """Reject unknown statuses: a typo must not read as an empty result.

    ``error`` is the one aggregate shorthand (every terminal state other than
    ``completed``), matching the timeseries' error accounting.
    """
    allowed = {member.value for member in GatewayEventStatus} | {"error"}
    if value is not None and value not in allowed:
        msg = f"Unknown status: {value} (expected error or one of {', '.join(sorted(allowed - {'error'}))})"
        raise ApiError(msg, status_code=400)
    return value


def _require_viewer(client: SupabaseClient, actor: RequestActor, org_id: str) -> None:
    """Gate a read on org membership."""
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )


class UsageBucket(BaseModel):
    """One (time bucket, model, lane) cell of the org's gateway usage.

    ``request_count`` counts every finished request in the cell, errors
    included; ``error_count`` is the subset whose terminal state was not
    ``completed``. ``lane`` is ``None`` when nothing was dispatched for the
    cell's requests. ``cost_usd`` is charged platform credits only;
    ``estimated_cost_usd`` is the attributed, never-charged pass-through
    estimate — sum the two for all-spend, but label them apart.
    """

    model_config = ConfigDict(frozen=True)

    bucket_start: str
    model: str
    lane: UsageLane | None
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    estimated_cost_usd: float


class UsageTimeseriesResponse(BaseModel):
    """Bucketed org-wide usage for the Telemetry charts."""

    model_config = ConfigDict(frozen=True)

    window: str
    bucket_seconds: int
    buckets: tuple[UsageBucket, ...]


class KeyModelUsage(BaseModel):
    """One model's share of an API key's traffic in the window."""

    model_config = ConfigDict(frozen=True)

    model: str
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    estimated_cost_usd: float


class KeyUsageTotals(BaseModel):
    """Window totals across all of one API key's models.

    ``cost_usd`` is charged credits; ``estimated_cost_usd`` is the
    never-charged pass-through estimate.
    """

    model_config = ConfigDict(frozen=True)

    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    estimated_cost_usd: float


class KeyUsage(BaseModel):
    """One API key's ("agent's") usage rollup.

    ``key_label`` is ``None`` when the key has been deleted since the traffic
    was served: the ledger keeps attribution as a snapshot, so history never
    disappears with the key. ``api_key_id`` itself is ``None`` only when the
    key was hard-deleted before the request settled.
    """

    model_config = ConfigDict(frozen=True)

    api_key_id: str | None
    key_label: str | None
    models: tuple[KeyModelUsage, ...]
    totals: KeyUsageTotals
    last_used_at: str


class UsageByKeyResponse(BaseModel):
    """Per-key usage rollups, highest window spend first."""

    model_config = ConfigDict(frozen=True)

    window: str
    keys: tuple[KeyUsage, ...]


class ProviderUsage(BaseModel):
    """One provider's ("platform's") usage rollup over the window.

    ``provider`` is the winning attempt's provider; ``None`` groups the
    requests where nothing was dispatched, surfaced honestly instead of
    dropped.
    """

    model_config = ConfigDict(frozen=True)

    provider: str | None
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: float
    estimated_cost_usd: float
    last_used_at: str


class UsageByProviderResponse(BaseModel):
    """Per-provider usage rollups, highest window spend first."""

    model_config = ConfigDict(frozen=True)

    window: str
    providers: tuple[ProviderUsage, ...]


class UsageRequestItem(BaseModel):
    """One gateway request in the Telemetry request log.

    This is the COMPLETE tenant-visible record: the gateway usage ledger is
    content-free (request/response bodies are never persisted), so unlike the
    legacy serving log there is no row-expand detail behind it. ``provider``
    and ``lane`` are ``None`` when nothing was dispatched;
    ``attempt_count`` is the number of physical provider dispatches (0 =
    failed before dispatch). ``tools_used`` is the distinct tool names the
    request invoked (names only, never arguments); it is an empty tuple when
    no tool activity was captured — the honest empty state the Telemetry page
    shows, and the current state everywhere because the WMO runtime does not
    yet surface tool names.

    ``cost_usd`` is CHARGED platform credits only (0 for pure-BYOK requests);
    ``estimated_cost_usd`` is the attributed, never-charged pass-through
    estimate; ``real_cost_usd`` is the always-real per-call cost (the two added
    together), so a BYOK row shows its real spend instead of a $0 charge. When
    ``pricing_known`` is ``False`` the winning attempt had no known price, so a
    ``real_cost_usd`` of 0 means "unpriced", not "free". ``failure_class`` and
    ``error_message`` carry the sanitized outcome reason for a non-``completed``
    request (both ``None`` otherwise); they are names/reasons only, never
    request content.
    """

    model_config = ConfigDict(frozen=True)

    request_id: str
    model: str
    provider: str | None
    lane: UsageLane | None
    # Null = the key was hard-deleted before the request settled.
    api_key_id: str | None
    key_label: str | None
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    reasoning_tokens: int
    cost_usd: float
    estimated_cost_usd: float
    real_cost_usd: float
    pricing_known: bool
    latency_ms: int | None
    # Time to first token (winning attempt dispatch -> first streamed token),
    # ms; None when no first token was observed (non-streaming settlement,
    # pre-dispatch failure, or a row settled before TTFT capture shipped).
    ttft_ms: int | None
    status: GatewayEventStatus
    attempt_count: int
    created_at: str
    tools_used: tuple[str, ...]
    failure_class: str | None
    error_message: str | None
    # Content-free lineage: requests sharing prompt_group ran the same agent
    # configuration; sharing conversation_group they belong to one
    # conversation. Short 12-hex handles of the ledger digests; None for rows
    # settled before lineage existed.
    prompt_group: str | None
    conversation_group: str | None


class UsageRequestsCursor(BaseModel):
    """Keyset cursor for the next page; echo the fields back verbatim."""

    model_config = ConfigDict(frozen=True)

    ts: str
    id: str
    after: str


class UsageRequestsResponse(BaseModel):
    """One page of the gateway request log, newest first."""

    model_config = ConfigDict(frozen=True)

    requests: tuple[UsageRequestItem, ...]
    next_cursor: UsageRequestsCursor | None


def _bucket_view(row: GatewayUsageBucketRow) -> UsageBucket:
    """Project one store timeseries row into the API cell."""
    return UsageBucket(
        bucket_start=row.bucket_start,
        model=row.alias,
        lane=_lane_to_api(row.lane),
        request_count=row.request_count,
        error_count=row.error_count,
        input_tokens=row.input_tokens,
        output_tokens=row.output_tokens,
        cost_usd=_micro_to_usd(row.cost_micro_usd),
        estimated_cost_usd=_micro_to_usd(row.estimated_cost_micro_usd),
    )


def _key_usage_views(rows: tuple[GatewayKeyModelUsageRow, ...]) -> tuple[KeyUsage, ...]:
    """Group flat (key, model) rows into per-key rollups, biggest spend first."""
    grouped: dict[str | None, list[GatewayKeyModelUsageRow]] = {}
    for row in rows:
        grouped.setdefault(row.api_key_id, []).append(row)
    keys: list[KeyUsage] = []
    for api_key_id, members in grouped.items():
        # "Spend" for ordering is all-spend: charged plus attributed estimate.
        members.sort(
            key=lambda member: member.cost_micro_usd + member.estimated_cost_micro_usd,
            reverse=True,
        )
        totals = KeyUsageTotals(
            request_count=sum(member.request_count for member in members),
            error_count=sum(member.error_count for member in members),
            input_tokens=sum(member.input_tokens for member in members),
            output_tokens=sum(member.output_tokens for member in members),
            cost_usd=_micro_to_usd(sum(member.cost_micro_usd for member in members)),
            estimated_cost_usd=_micro_to_usd(
                sum(member.estimated_cost_micro_usd for member in members)
            ),
        )
        keys.append(
            KeyUsage(
                api_key_id=api_key_id,
                key_label=members[0].key_label,
                models=tuple(
                    KeyModelUsage(
                        model=member.alias,
                        request_count=member.request_count,
                        error_count=member.error_count,
                        input_tokens=member.input_tokens,
                        output_tokens=member.output_tokens,
                        cost_usd=_micro_to_usd(member.cost_micro_usd),
                        estimated_cost_usd=_micro_to_usd(member.estimated_cost_micro_usd),
                    )
                    for member in members
                ),
                totals=totals,
                last_used_at=max(member.last_used_at for member in members),
            )
        )
    keys.sort(
        key=lambda key: (
            key.totals.cost_usd + key.totals.estimated_cost_usd,
            key.totals.request_count,
        ),
        reverse=True,
    )
    return tuple(keys)


def _provider_usage_views(
    rows: tuple[GatewayProviderUsageRow, ...],
) -> tuple[ProviderUsage, ...]:
    """Project provider rollup rows onto the API shape, biggest spend first."""
    views = [
        ProviderUsage(
            provider=row.provider,
            request_count=row.request_count,
            error_count=row.error_count,
            input_tokens=row.input_tokens,
            output_tokens=row.output_tokens,
            cost_usd=_micro_to_usd(row.cost_micro_usd),
            estimated_cost_usd=_micro_to_usd(row.estimated_cost_micro_usd),
            last_used_at=row.last_used_at,
        )
        for row in rows
    ]
    # "Spend" for ordering is all-spend: charged plus attributed estimate.
    views.sort(
        key=lambda view: (view.cost_usd + view.estimated_cost_usd, view.request_count),
        reverse=True,
    )
    return tuple(views)


def _event_view(row: GatewayUsageEventRow) -> UsageRequestItem:
    """Project one store event row into the API request item."""
    return UsageRequestItem(
        request_id=row.request_id,
        model=row.alias,
        provider=row.provider,
        lane=_lane_to_api(row.lane),
        api_key_id=row.api_key_id,
        key_label=row.key_label,
        input_tokens=row.input_tokens,
        output_tokens=row.output_tokens,
        cached_input_tokens=row.cached_input_tokens,
        reasoning_tokens=row.reasoning_tokens,
        cost_usd=_micro_to_usd(row.cost_micro_usd),
        estimated_cost_usd=_micro_to_usd(row.estimated_cost_micro_usd),
        # The always-real per-call cost: charged credits plus the never-charged
        # BYOK estimate. Exactly one is nonzero per lane (or both zero when the
        # route was unpriced — pricing_known then reads False).
        real_cost_usd=_micro_to_usd(row.cost_micro_usd + row.estimated_cost_micro_usd),
        pricing_known=row.pricing_known,
        latency_ms=row.latency_ms,
        ttft_ms=row.ttft_ms,
        status=row.status,
        attempt_count=row.attempt_count,
        created_at=row.created_at,
        # None (not captured) and empty read the same to the tenant: the empty
        # tuple is the honest empty state the request log renders.
        tools_used=row.tools_used or (),
        failure_class=row.failure_class,
        error_message=row.error_message,
        prompt_group=None if row.prompt_sha256 is None else row.prompt_sha256[:12],
        conversation_group=(
            None if row.conversation_sha256 is None else row.conversation_sha256[:12]
        ),
    )


@router.get("/orgs/{org_id}/usage/timeseries")
async def get_usage_timeseries(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
    model: str | None = None,
    api_key_id: str | None = None,
    lane: str | None = None,
) -> UsageTimeseriesResponse:
    """Bucket the org's gateway usage per (model, lane) over a window.

    Every filter composes; an omitted filter means "all". 24h windows bucket
    hourly, the longer windows daily.
    """
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    key, after, bucket_seconds = _window(window)
    if api_key_id is not None:
        _uuid_or_400(api_key_id, "api_key_id")
    lane_filter = _lane_filter_or_400(lane)
    rows = await asyncio.to_thread(
        GatewayUsageStore(client).usage_timeseries,
        org_id,
        after=after,
        bucket_seconds=bucket_seconds,
        alias=model,
        api_key_id=api_key_id,
        lane=lane_filter,
    )
    return UsageTimeseriesResponse(
        window=key,
        bucket_seconds=bucket_seconds,
        buckets=tuple(_bucket_view(row) for row in rows),
    )


@router.get("/orgs/{org_id}/usage/by-key")
async def get_usage_by_key(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
) -> UsageByKeyResponse:
    """Roll up the org's gateway usage per API key ("agent") over a window."""
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    key, after, _ = _window(window)
    rows = await asyncio.to_thread(
        GatewayUsageStore(client).usage_by_key,
        org_id,
        after=after,
    )
    return UsageByKeyResponse(window=key, keys=_key_usage_views(rows))


@router.get("/orgs/{org_id}/usage/by-provider")
async def get_usage_by_provider(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
) -> UsageByProviderResponse:
    """Roll up the org's gateway usage per provider ("platform") over a window."""
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    key, after, _ = _window(window)
    rows = await asyncio.to_thread(
        GatewayUsageStore(client).usage_by_provider,
        org_id,
        after=after,
    )
    return UsageByProviderResponse(window=key, providers=_provider_usage_views(rows))


@router.get("/orgs/{org_id}/suggestions")
async def get_suggestions(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
) -> SuggestionsResponse:
    """Run the interim suggestions rules over the org's window of usage.

    The response shape is the stable contract the real suggestions engine
    later fills (see explabs/api/suggestions.py). Rules read the same
    aggregates the timeseries and request-log endpoints serve: the full
    unfiltered window per (model, lane), plus the most recent request rows
    for the latency rule's sample.
    """
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    key, after, bucket_seconds = _window(window)
    store = GatewayUsageStore(client)
    buckets, events, prompts = await asyncio.gather(
        asyncio.to_thread(
            store.usage_timeseries, org_id, after=after, bucket_seconds=bucket_seconds
        ),
        asyncio.to_thread(store.list_events, org_id, after=after, limit=_LIST_CAP),
        asyncio.to_thread(store.usage_by_prompt, org_id, after=after),
    )
    return SuggestionsResponse(
        suggestions=generate_suggestions(buckets, events, key, prompts=prompts)
    )


class PromptGroupUsage(BaseModel):
    """One repeated-prompt group's usage rollup on one model.

    ``prompt_group`` is the short handle of the content-free lineage digest
    (see explabs/gateway/lineage.py): every request in the group resent the
    same system prompt and tool declarations. ``stable_prefix_tokens_estimate``
    derives from the prefix's character length at ~4 chars/token and is an
    ESTIMATE, labeled as such wherever it renders.
    """

    model_config = ConfigDict(frozen=True)

    prompt_group: str
    model: str
    request_count: int
    error_count: int
    conversation_count: int
    agent_count: int
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    cost_usd: float
    estimated_cost_usd: float
    stable_prefix_tokens_estimate: int
    last_used_at: str
    # The captured system-prompt snippet labeling this group; None for orgs
    # without the prompt-capture opt-in (the digest handle renders instead).
    prompt_snippet: str | None = None


class UsageByPromptResponse(BaseModel):
    """Per-(prompt group, model) rollups, busiest first."""

    model_config = ConfigDict(frozen=True)

    window: str
    prompts: tuple[PromptGroupUsage, ...]


@router.get("/orgs/{org_id}/usage/by-prompt")
async def get_usage_by_prompt(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
) -> UsageByPromptResponse:
    """Roll up the org's gateway usage per repeated-prompt group over a window.

    Rows settled before request lineage existed carry no group and never
    appear here; an org whose traffic predates the feature reads an honest
    empty list.
    """
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    key, after, _ = _window(window)
    rows, snippets = await asyncio.gather(
        asyncio.to_thread(GatewayUsageStore(client).usage_by_prompt, org_id, after=after),
        # Text labels exist only for orgs that opted into prompt capture;
        # everyone else renders the content-free digest handle.
        asyncio.to_thread(GatewayCaptureStore(client).group_snippets, org_id),
    )
    snippet_by_group = {snippet.prompt_sha256: snippet.snippet for snippet in snippets}
    return UsageByPromptResponse(
        window=key,
        prompts=tuple(
            PromptGroupUsage(
                prompt_group=row.prompt_sha256[:12],
                model=row.alias,
                request_count=row.request_count,
                error_count=row.error_count,
                conversation_count=row.conversation_count,
                agent_count=row.agent_count,
                input_tokens=row.input_tokens,
                output_tokens=row.output_tokens,
                cached_input_tokens=row.cached_input_tokens,
                cost_usd=_micro_to_usd(row.cost_micro_usd),
                estimated_cost_usd=_micro_to_usd(row.estimated_cost_micro_usd),
                stable_prefix_tokens_estimate=row.stable_prefix_chars // 4,
                last_used_at=row.last_used_at,
                prompt_snippet=snippet_by_group.get(row.prompt_sha256),
            )
            for row in rows
        ),
    )


class CapturedPromptResponse(BaseModel):
    """One request's captured prompt, for the request log's expansion.

    Exists only for organizations that opted into prompt capture
    (``capture_prompt_content``) and only within the capture retention
    window; everything else is a 404, indistinguishable from a request that
    was never captured.
    """

    model_config = ConfigDict(frozen=True)

    request_id: str
    messages: tuple[JsonObject, ...]
    captured_at: str


@router.get("/orgs/{org_id}/usage/requests/{request_id}/prompt")
async def get_captured_prompt(
    org_id: str,
    request_id: str,
    client: Client,
    actor: Actor,
) -> CapturedPromptResponse:
    """Read one request's captured prompt (org-scoped, opt-in only)."""
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    row = await asyncio.to_thread(GatewayCaptureStore(client).read_prompt, org_id, request_id)
    if row is None:
        msg = f"No captured prompt for request: {request_id}"
        raise ApiError(msg, status_code=404)
    return CapturedPromptResponse(
        request_id=row.request_id,
        messages=row.messages,
        captured_at=row.captured_at,
    )


class InsightQueryRequest(BaseModel):
    """A natural-language question over the org's own usage.

    The window is parsed from the question itself (e.g. "last week"); the
    optional ``window`` field is not accepted here on purpose, so the answer's
    stated window and the question always agree.
    """

    model_config = ConfigDict(frozen=True)

    question: str


@router.post("/orgs/{org_id}/insights/query")
async def query_insights(
    org_id: str,
    body: InsightQueryRequest,
    client: Client,
    actor: Actor,
) -> InsightAnswer:
    """Answer a plain-language usage question over the org's OWN aggregates.

    The question is classified into a typed query (a fixed metric over a fixed
    dimension and window; see explabs/api/insights_query.py) and answered by
    reading the same tenant usage aggregates the Telemetry endpoints serve.
    The deterministic parser runs first (fast, free, credential-less); when it
    cannot read the question and the deployment carries a house LLM
    credential, the LLM planner maps the free-form words onto the SAME typed
    query (explabs/api/insights_llm.py — the model sees only the question
    string, never usage data). There is still no free-form query path: a
    question neither can map returns an "I can't answer that" answer with
    example questions, and every read is org-scoped by the same membership
    gate as the rest of this surface.
    """
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    query = parse_insight_query(body.question)
    if query is None:
        planner = default_planner()
        if planner is not None:
            query = await asyncio.to_thread(planner.plan, body.question)
    if query is None:
        return not_understood_answer()
    _, after, bucket_seconds = _window(query.window.value)
    store = GatewayUsageStore(client)
    buckets, events, by_key = await asyncio.gather(
        asyncio.to_thread(
            store.usage_timeseries, org_id, after=after, bucket_seconds=bucket_seconds
        ),
        asyncio.to_thread(store.list_events, org_id, after=after, limit=_LIST_CAP),
        asyncio.to_thread(store.usage_by_key, org_id, after=after),
    )
    return answer_insight_query(query, buckets, events, by_key)


@router.post("/orgs/{org_id}/insights/agent-advice")
async def run_agent_advice(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
) -> SuggestionsResponse:
    """Run the on-demand advice agent over the org's window of aggregates.

    The agent (explabs/api/insights_agent.py) explores the same content-free,
    org-scoped aggregate reads this router already serves and returns
    suggestions in the deterministic engine's stable contract. It exists only
    when the deployment carries a house LLM credential; without one this
    answers a clean typed error instead of pretending to analyze.
    """
    # Membership first: capability probing must never answer before
    # authorization, or a non-member could read deployment LLM configuration
    # from the 503-vs-404 split.
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    agent = default_advice_agent()
    if agent is None:
        msg = "agent advice needs a platform LLM credential; the rule-based suggestions remain available"
        raise ApiError(msg, status_code=503)
    _, after, bucket_seconds = _window(window)
    store = GatewayUsageStore(client)

    def _reads() -> dict[str, Callable[[], object]]:
        return {
            "usage_timeseries": lambda: [
                row.model_dump(mode="json")
                for row in store.usage_timeseries(
                    org_id, after=after, bucket_seconds=bucket_seconds
                )
            ],
            "usage_by_key": lambda: [
                row.model_dump(mode="json") for row in store.usage_by_key(org_id, after=after)
            ],
            "usage_by_prompt": lambda: [
                row.model_dump(mode="json") for row in store.usage_by_prompt(org_id, after=after)
            ],
            "recent_requests": lambda: [
                row.model_dump(mode="json")
                for row in store.list_events(org_id, after=after, limit=_AGENT_EVENT_SAMPLE)
            ],
        }

    suggestions = await asyncio.to_thread(agent.run, _reads())
    return SuggestionsResponse(suggestions=suggestions)


class TelemetrySettings(BaseModel):
    """The org's telemetry privacy settings.

    ``capture_prompt_content`` is the opt-in to ALSO capture request/response
    content in telemetry. Default ``False``: the content-free metadata stream
    (tokens, cost, latency, provider, outcome reason) is always captured, and
    only this flag authorizes storing message content — which the platform can
    persist once the content-free runtime surfaces it, the same activation gate
    as tool-name capture. The bodies are never captured while it is off.
    """

    model_config = ConfigDict(frozen=True)

    capture_prompt_content: bool


def _telemetry_settings(org: JsonObject) -> TelemetrySettings:
    """Project an organizations row into the telemetry settings view."""
    return TelemetrySettings(
        capture_prompt_content=bool(org.get("capture_prompt_content", False)),
    )


@router.get("/orgs/{org_id}/telemetry-settings")
async def get_telemetry_settings(
    org_id: str,
    client: Client,
    actor: Actor,
) -> TelemetrySettings:
    """Return the org's telemetry privacy settings (any member can read)."""
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    org = await asyncio.to_thread(load_organization, client, org_id)
    return _telemetry_settings(org)


@router.put("/orgs/{org_id}/telemetry-settings")
async def set_telemetry_settings(
    org_id: str,
    body: TelemetrySettings,
    client: Client,
    actor: Actor,
) -> TelemetrySettings:
    """Set the org's telemetry privacy settings.

    Admin-gated: capturing prompt/response content is a privacy decision for the
    whole organization, so only an org admin can turn it on or off. Turning it
    off never deletes already-captured content here; it stops future capture.
    """
    await asyncio.to_thread(
        require_org_role,
        client,
        actor,
        org_id,
        OrgRole.ADMIN,
        not_found=f"Organization not found: {org_id}",
    )
    await asyncio.to_thread(
        update_by_id,
        client,
        "organizations",
        org_id,
        {"capture_prompt_content": body.capture_prompt_content},
    )
    return body


@router.get("/orgs/{org_id}/usage/requests")
async def list_usage_requests(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
    model: str | None = None,
    api_key_id: str | None = None,
    lane: str | None = None,
    status: str | None = None,
    cursor_ts: str | None = None,
    cursor_id: str | None = None,
    cursor_after: str | None = None,
    limit: int = 50,
) -> UsageRequestsResponse:
    """List the org's gateway requests, newest first.

    ``next_cursor`` is returned while a full page came back; echo its fields
    back as ``cursor_ts``/``cursor_id``/``cursor_after`` to fetch the next
    page. ``cursor_after`` freezes the window's lower bound across pages so
    the oldest rows cannot slide out of a recomputed window mid-pagination.
    """
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    if api_key_id is not None:
        _uuid_or_400(api_key_id, "api_key_id")
    lane_filter = _lane_filter_or_400(lane)
    _status_or_400(status)
    if (cursor_ts is None) != (cursor_id is None):
        msg = "Pass cursor_ts and cursor_id together or not at all"
        raise ApiError(msg, status_code=400)
    if cursor_ts is not None:
        _timestamp_or_400(cursor_ts, "cursor_ts")
    if cursor_after is not None:
        after = _timestamp_or_400(cursor_after, "cursor_after")
    else:
        _, after, _ = _window(window)
    effective_limit = min(max(limit, 1), _LIST_CAP)
    rows = await asyncio.to_thread(
        GatewayUsageStore(client).list_events,
        org_id,
        after=after,
        alias=model,
        api_key_id=api_key_id,
        lane=lane_filter,
        status=status,
        cursor_ts=cursor_ts,
        cursor_id=cursor_id,
        limit=effective_limit,
    )
    next_cursor: UsageRequestsCursor | None = None
    if len(rows) == effective_limit:
        next_cursor = UsageRequestsCursor(
            ts=rows[-1].created_at,
            id=rows[-1].request_id,
            after=after,
        )
    return UsageRequestsResponse(
        requests=tuple(_event_view(row) for row in rows),
        next_cursor=next_cursor,
    )


def _group_by_or_400(value: str | None) -> GatewayInsightsGroupBy:
    """Resolve the insights grouping dimension, defaulting to day.

    A typo must not silently read as an empty result, so an unknown dimension
    is a 400 rather than a pass-through to the RPC's own 22023.
    """
    if value is None:
        return GatewayInsightsGroupBy.DAY
    try:
        return GatewayInsightsGroupBy(value)
    except ValueError as error:
        allowed = ", ".join(member.value for member in GatewayInsightsGroupBy)
        msg = f"Unknown group_by: {value} (expected one of {allowed})"
        raise ApiError(msg, status_code=400) from error


class InsightsMetricCell(BaseModel):
    """One grouped cell of the deep Insights metrics.

    ``bucket_key`` is an ISO-8601 UTC instant for ``day`` grouping, the model
    for ``model``, or the winning provider (``"(no dispatch)"`` when nothing was
    dispatched) for ``provider``. ``cache_hit_rate`` is cached input over total
    input (``None`` when no input tokens); ``tokens_per_second`` is completion
    tokens over generation seconds across dispatched rows (``None`` when nothing
    was dispatched). ``avg_*_ms`` average over dispatched rows only.
    ``cost_usd`` is charged credits; ``estimated_cost_usd`` the never-charged
    pass-through estimate.
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
    cache_hit_rate: float | None
    tokens_per_second: float | None
    avg_generation_duration_ms: float | None
    avg_routing_overhead_ms: float | None
    avg_latency_ms: float | None
    cost_usd: float
    estimated_cost_usd: float


class InsightsMetricsResponse(BaseModel):
    """Windowed deep-telemetry cells for the Insights page."""

    model_config = ConfigDict(frozen=True)

    window: str
    group_by: GatewayInsightsGroupBy
    cells: tuple[InsightsMetricCell, ...]


class TokensPerSecondPoint(BaseModel):
    """One time bucket of the tokens/second series.

    ``tokens_per_second`` is completion tokens over generation seconds for the
    bucket; only dispatched requests enter the series, so an empty bucket simply
    has no point.
    """

    model_config = ConfigDict(frozen=True)

    bucket_start: str
    request_count: int
    completion_tokens: int
    generation_ms: int
    tokens_per_second: float | None


class TokensPerSecondResponse(BaseModel):
    """The tok/s-over-time series for the Insights throughput chart."""

    model_config = ConfigDict(frozen=True)

    window: str
    bucket_seconds: int
    points: tuple[TokensPerSecondPoint, ...]


class TopApp(BaseModel):
    """One attribution row for the Insights "top apps" panel.

    The attribution unit is the API key: ``app_label`` is the key's name,
    ``None`` when the key was deleted after settlement (history is kept as a
    snapshot). A ``None`` ``api_key_id`` means the key was hard-deleted before
    the request settled. Header-based app labels (HTTP-Referer / X-Title)
    require a runtime change and are not yet surfaced.
    """

    model_config = ConfigDict(frozen=True)

    api_key_id: str | None
    app_label: str | None
    request_count: int
    error_count: int
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int
    cost_usd: float
    estimated_cost_usd: float
    last_used_at: str


class TopAppsResponse(BaseModel):
    """Ranked attribution keys for the Insights "top apps" panel."""

    model_config = ConfigDict(frozen=True)

    window: str
    apps: tuple[TopApp, ...]


def _metric_cell_view(row: GatewayInsightsMetricRow) -> InsightsMetricCell:
    """Shape one metrics RPC row for the API, converting money to dollars."""
    return InsightsMetricCell(
        bucket_key=row.bucket_key,
        request_count=row.request_count,
        completed_count=row.completed_count,
        error_count=row.error_count,
        prompt_tokens=row.prompt_tokens,
        completion_tokens=row.completion_tokens,
        reasoning_tokens=row.reasoning_tokens,
        cached_input_tokens=row.cached_input_tokens,
        cache_hit_rate=row.cache_hit_rate,
        tokens_per_second=row.tokens_per_second,
        avg_generation_duration_ms=row.avg_generation_duration_ms,
        avg_routing_overhead_ms=row.avg_routing_overhead_ms,
        avg_latency_ms=row.avg_latency_ms,
        cost_usd=_micro_to_usd(row.cost_micro_usd),
        estimated_cost_usd=_micro_to_usd(row.estimated_cost_micro_usd),
    )


def _tps_point_view(row: GatewayTokensPerSecondRow) -> TokensPerSecondPoint:
    """Shape one tok/s-series RPC row for the API."""
    return TokensPerSecondPoint(
        bucket_start=row.bucket_start,
        request_count=row.request_count,
        completion_tokens=row.completion_tokens,
        generation_ms=row.generation_ms,
        tokens_per_second=row.tokens_per_second,
    )


def _top_app_view(row: GatewayTopAppRow) -> TopApp:
    """Shape one top-apps RPC row for the API, converting money to dollars."""
    return TopApp(
        api_key_id=row.api_key_id,
        app_label=row.app_label,
        request_count=row.request_count,
        error_count=row.error_count,
        prompt_tokens=row.prompt_tokens,
        completion_tokens=row.completion_tokens,
        reasoning_tokens=row.reasoning_tokens,
        cost_usd=_micro_to_usd(row.cost_micro_usd),
        estimated_cost_usd=_micro_to_usd(row.estimated_cost_micro_usd),
        last_used_at=row.last_used_at,
    )


@router.get("/orgs/{org_id}/insights/metrics")
async def get_insights_metrics(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
    group_by: str | None = None,
) -> InsightsMetricsResponse:
    """Deep telemetry aggregates grouped by day, model, or provider.

    Each cell carries the token breakdown (prompt/completion/reasoning/cached),
    cache-hit rate, aggregate tokens/second, and average routing overhead,
    generation duration, and end-to-end latency over the window. 24h windows
    bucket ``day`` hourly, the longer windows daily.
    """
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    key, after, bucket_seconds = _window(window)
    dimension = _group_by_or_400(group_by)
    rows = await asyncio.to_thread(
        GatewayUsageStore(client).insights_metrics,
        org_id,
        group_by=dimension,
        after=after,
        bucket_seconds=bucket_seconds,
    )
    return InsightsMetricsResponse(
        window=key,
        group_by=dimension,
        cells=tuple(_metric_cell_view(row) for row in rows),
    )


@router.get("/orgs/{org_id}/insights/tokens-per-second")
async def get_insights_tokens_per_second(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
    model: str | None = None,
    provider: str | None = None,
) -> TokensPerSecondResponse:
    """Tokens/second over time: completion tokens over generation seconds.

    Only dispatched requests enter the series, so a bucket with no throughput is
    simply absent. Both the model and provider filters compose.
    """
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    key, after, bucket_seconds = _window(window)
    rows = await asyncio.to_thread(
        GatewayUsageStore(client).insights_tokens_per_second,
        org_id,
        after=after,
        bucket_seconds=bucket_seconds,
        alias=model,
        provider=provider,
    )
    return TokensPerSecondResponse(
        window=key,
        bucket_seconds=bucket_seconds,
        points=tuple(_tps_point_view(row) for row in rows),
    )


@router.get("/orgs/{org_id}/insights/top-apps")
async def get_insights_top_apps(
    org_id: str,
    client: Client,
    actor: Actor,
    window: str | None = None,
    limit: int = 20,
) -> TopAppsResponse:
    """Rank the org's attribution keys ("apps") by traffic over a window."""
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    key, after, _ = _window(window)
    rows = await asyncio.to_thread(
        GatewayUsageStore(client).insights_top_apps,
        org_id,
        after=after,
        limit=min(max(limit, 1), 100),
    )
    return TopAppsResponse(window=key, apps=tuple(_top_app_view(row) for row in rows))
