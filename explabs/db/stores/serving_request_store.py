# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for the endpoint serving-request log.

``serving_requests`` records one row per call served through a hosted
endpoint (D-SERVING-LOG v1): the operational record behind the Telemetry
page. This store owns the read path (list, detail, window stats, activity
buckets, endpoint roll-up) plus the insert the serving path and seeds use.

Rows carry the learned-inference-policy fields (``model``, ``provider_model``,
``cluster_id``, ``cluster_label``, ``routing_reason``, ``router_cost_usd``,
``leg``) so one call's decision is reconstructable, but the list read
deliberately excludes them along with request/response bodies so list rows
stay light. The single-row fetch returns the full row, which feeds two
differently shaped views: the tenant detail (an allowlist of outcome columns,
``model`` included since the gateway-launch reclassification, the routing
mechanism excluded) and the platform-admin routing audit (the whole decision).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from enum import StrEnum
from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from explabs.db.repositories import (
    JsonObject,
    JsonPayload,
    SupabaseClient,
    first_row,
    result_rows,
)

# Default page size for the request list; the RPC caps at 200 regardless.
DEFAULT_LIST_LIMIT = 50

# Batch size for request inserts, matching the platform's other bulk writers.
INSERT_CHUNK_SIZE = 500

# Write-path cap per stored body. Bodies above this are replaced with a
# truncation marker carrying a bounded preview: the log row itself must never
# be lost to body size (the migration's 2 MiB checks are only the backstop).
BODY_MAX_BYTES = 1_048_576
_BODY_PREVIEW_CHARS = 4_096


def bounded_serving_body(body: object) -> object:
    """Return a persistable body or a bounded, customer-safe truncation marker.

    Args:
        body: JSON-compatible serving request or response body.

    Returns:
        The original body when it fits, otherwise a bounded marker carrying
        only its encoded size and a short preview.
    """
    if body is None:
        return None
    serialized = json.dumps(body, ensure_ascii=False)
    if len(serialized.encode("utf-8")) <= BODY_MAX_BYTES:
        return body
    return {
        "truncated": True,
        "original_bytes": len(serialized.encode("utf-8")),
        "preview": serialized[:_BODY_PREVIEW_CHARS],
    }


class ServingLeg(StrEnum):
    """D-METERING leg a served call is metered under.

    Mirrors the column's CHECK and wmo's ``RequestLogRecord.leg`` literal. A
    value outside this set fails the row at the typed boundary rather than
    travelling on as an uncategorized string.
    """

    SERVING = "serving"
    OPTIMIZATION = "optimization"
    EVAL = "eval"
    OVERHEAD = "overhead"


class ProjectServingBillingSource(StrEnum):
    """Top-level payer composition for one Project request."""

    HOST_MANAGED = "host_managed"
    CUSTOMER_MANAGED = "customer_managed"
    MIXED = "mixed"
    NONE = "none"


class ProjectServingBillingComponents(BaseModel):
    """Safe payer source for each fixed Project serving component."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    router_embedding: Literal["host_managed", "customer_managed", "not_applicable"]
    selected_candidate: Literal[
        "host_managed",
        "customer_managed",
        "not_applicable",
    ]


class ServingRequestListItem(BaseModel):
    """One row from ``list_serving_requests`` (no bodies, no routing fields)."""

    model_config = ConfigDict(frozen=True)

    id: str
    endpoint_id: str
    endpoint_label: str
    project_id: str | None = None
    billing_source: ProjectServingBillingSource | None = None
    billing_components: ProjectServingBillingComponents | None = None
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    cost_usd: float | None = None
    latency_ms: int | None = None
    ttfb_ms: int | None = None
    status: str
    error_message: str | None = None
    created_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> ServingRequestListItem:
        """Parse an RPC row."""
        return cls.model_validate(dict(row))


class ServingRequestRecord(BaseModel):
    """Full ``serving_requests`` row, bodies and routing fields included."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    id: str
    org_id: str
    endpoint_id: str
    endpoint_label: str
    project_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("project_id", "optimizer_project_id"),
    )
    billing_source: ProjectServingBillingSource | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "billing_source",
            "optimizer_project_billing_source",
        ),
    )
    billing_components: ProjectServingBillingComponents | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "billing_components",
            "optimizer_project_billing_breakdown",
        ),
    )
    model: str | None = None
    # The provider runtime id behind ``model``: server-internal, like every
    # other provider resource id.
    provider_model: str | None = None
    cluster_id: str | None = None
    cluster_label: str | None = None
    # Why the policy chose ``model`` for this call.
    routing_reason: str | None = None
    # The routing decision's own inference cost. The serving path always
    # reports it (wmo types it as a plain float), so None means the row predates
    # the column, not that a policy declined to say. A real 0.0 means the
    # policy was free to evaluate.
    router_cost_usd: float | None = None
    # D-METERING leg. Rows predating the column read as customer serving
    # traffic, which is what the database default backfilled them to.
    leg: ServingLeg = ServingLeg.SERVING
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    cost_usd: float | None = None
    # BYOK billing attribution: the call rode the org's own provider key, so
    # its cost is metered but never draws down platform credits. The
    # connection id is the drawdown target for the customer's declared
    # provider balance; it nulls out if the connection is disconnected while
    # `byok` stays frozen (the spend triggers reverse deletes off it).
    byok: bool = False
    provider_connection_id: str | None = None
    latency_ms: int | None = None
    ttfb_ms: int | None = None
    status: str
    error_message: str | None = None
    request: JsonObject | None = None
    response: JsonObject | None = None
    created_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> ServingRequestRecord:
        """Parse a persisted row."""
        return cls.model_validate(dict(row))


class ServingRequestStats(BaseModel):
    """Window aggregates from ``serving_request_stats``."""

    model_config = ConfigDict(frozen=True)

    request_count: int
    error_count: int
    # Rows with no verified price; a partially priced window's spend total
    # must not read as complete.
    unpriced_count: int
    cost_usd_total: float | None = None
    input_tokens_total: int
    output_tokens_total: int
    cached_tokens_total: int
    # Rows priced at a true $0 (customer-declared free models). Counted and
    # token-summed separately so savings math can leave them out of a
    # frontier comparison instead of claiming the whole baseline as saved.
    zero_cost_count: int = 0
    zero_cost_input_tokens: int = 0
    zero_cost_output_tokens: int = 0
    zero_cost_cached_tokens: int = 0
    latency_p50_ms: float | None = None
    latency_p95_ms: float | None = None

    @classmethod
    def from_row(cls, row: JsonObject) -> ServingRequestStats:
        """Parse the single aggregate RPC row."""
        return cls.model_validate(dict(row))


class ServingRequestBucket(BaseModel):
    """One time bucket from ``list_serving_request_buckets``."""

    model_config = ConfigDict(frozen=True)

    bucket_start: str
    request_count: int
    error_count: int

    @classmethod
    def from_row(cls, row: JsonObject) -> ServingRequestBucket:
        """Parse a bucket RPC row."""
        return cls.model_validate(dict(row))


class EndpointModelUsageRow(BaseModel):
    """One routed model's share of an endpoint's traffic (``endpoint_usage_rollup``)."""

    model_config = ConfigDict(frozen=True)

    # Routed pool entry name; "" groups rows captured without routing evidence.
    model: str
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    # Priced spend only; unpriced_count rows are reported beside it, never as $0.
    cost_usd: float
    unpriced_count: int

    @classmethod
    def from_row(cls, row: JsonObject) -> EndpointModelUsageRow:
        """Parse a rollup RPC row."""
        return cls.model_validate(dict(row))


class EndpointUsageBucketRow(BaseModel):
    """One (model, time-bucket) cell from ``endpoint_usage_timeseries``.

    Same honesty rules as :class:`EndpointModelUsageRow` (tokens and cost sum
    over all rows including errors; unpriced stays a count), plus the
    zero-cost token sums the savings math excludes from the frontier baseline,
    matching :class:`ServingRequestStats`.
    """

    model_config = ConfigDict(frozen=True)

    bucket_start: str
    # Routed pool entry name; "" groups rows captured without routing evidence.
    model: str
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    cost_usd: float
    unpriced_count: int
    zero_cost_input_tokens: int = 0
    zero_cost_output_tokens: int = 0
    zero_cost_cached_tokens: int = 0

    @classmethod
    def from_row(cls, row: JsonObject) -> EndpointUsageBucketRow:
        """Parse a timeseries RPC row."""
        return cls.model_validate(dict(row))


class ServingEndpointRecord(BaseModel):
    """One served endpoint from ``list_serving_endpoints``."""

    model_config = ConfigDict(frozen=True)

    endpoint_id: str
    endpoint_label: str
    request_count: int
    last_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> ServingEndpointRecord:
        """Parse an endpoint roll-up RPC row."""
        return cls.model_validate(dict(row))


class ServingRequestStore:
    """Read and record endpoint serving requests."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client.
        """
        self._client = client

    def insert_requests(self, payloads: Sequence[JsonPayload]) -> int:
        """Upsert request rows in bounded batches.

        Conflicts on ``id`` are ignored so a retried write converges instead
        of raising; the serving path supplies stable ids per call. Bodies
        above ``BODY_MAX_BYTES`` are replaced with a truncation marker (a
        bounded preview plus the original size) so no row is ever rejected
        for body size.

        Args:
            payloads: Fully-formed ``serving_requests`` row payloads.

        Returns:
            Number of rows actually inserted.
        """
        bounded: list[JsonObject] = []
        for payload in payloads:
            row = dict(payload)
            row["request"] = bounded_serving_body(row.get("request"))
            row["response"] = bounded_serving_body(row.get("response"))
            bounded.append(row)
        inserted = 0
        for start in range(0, len(bounded), INSERT_CHUNK_SIZE):
            chunk = bounded[start : start + INSERT_CHUNK_SIZE]
            result = (
                self._client.table("serving_requests")
                .upsert(chunk, on_conflict="id", ignore_duplicates=True)
                .execute()
            )
            inserted += len(result_rows(result))
        return inserted

    def list_requests(
        self,
        org_id: str,
        *,
        endpoint_id: str | None = None,
        project_id: str | None = None,
        status: str | None = None,
        after: str | None = None,
        before: str | None = None,
        cursor_ts: str | None = None,
        cursor_id: str | None = None,
        limit: int = DEFAULT_LIST_LIMIT,
    ) -> tuple[ServingRequestListItem, ...]:
        """List requests newest first with keyset pagination.

        Args:
            org_id: Owning organization identifier.
            endpoint_id: Restrict to one endpoint.
            project_id: Restrict to one optimizer Project.
            status: Restrict to ``ok`` or ``error``.
            after: Inclusive lower bound on ``created_at``.
            before: Exclusive upper bound on ``created_at``.
            cursor_ts: ``created_at`` of the last row of the previous page.
            cursor_id: ``id`` of the last row of the previous page.
            limit: Page size (the RPC caps at 200).

        Returns:
            Matching list items, newest first.
        """
        result = self._client.rpc(
            "list_serving_requests",
            {
                "in_org": org_id,
                "in_endpoint": endpoint_id,
                "in_project": project_id,
                "in_status": status,
                "in_after": after,
                "in_before": before,
                "in_cursor_ts": cursor_ts,
                "in_cursor_id": cursor_id,
                "in_limit": limit,
            },
        ).execute()
        return tuple(ServingRequestListItem.from_row(row) for row in result_rows(result))

    def get_request(self, request_id: str) -> ServingRequestRecord:
        """Fetch one request by identifier, bodies included.

        Args:
            request_id: Request identifier.

        Returns:
            Current record.

        Raises:
            RepositoryError: If the request does not exist.
        """
        result = self._client.table("serving_requests").select("*").eq("id", request_id).execute()
        return ServingRequestRecord.from_row(first_row(result, context="fetch serving request"))

    def stats(
        self,
        org_id: str,
        *,
        endpoint_id: str | None = None,
        project_id: str | None = None,
        after: str | None = None,
        before: str | None = None,
    ) -> ServingRequestStats:
        """Aggregate a window: counts, spend, tokens, latency percentiles.

        Args:
            org_id: Owning organization identifier.
            endpoint_id: Restrict to one endpoint.
            project_id: Restrict to one optimizer Project.
            after: Inclusive lower bound on ``created_at``.
            before: Exclusive upper bound on ``created_at``.

        Returns:
            Window aggregates (zero counts when the window is empty).
        """
        result = self._client.rpc(
            "serving_request_stats",
            {
                "in_org": org_id,
                "in_endpoint": endpoint_id,
                "in_project": project_id,
                "in_after": after,
                "in_before": before,
            },
        ).execute()
        return ServingRequestStats.from_row(first_row(result, context="aggregate serving requests"))

    def buckets(
        self,
        org_id: str,
        *,
        endpoint_id: str | None = None,
        project_id: str | None = None,
        after: str | None = None,
        before: str | None = None,
        bucket_seconds: int = 86_400,
    ) -> tuple[ServingRequestBucket, ...]:
        """Bucket request counts over time for the activity chart.

        Args:
            org_id: Owning organization identifier.
            endpoint_id: Restrict to one endpoint.
            project_id: Restrict to one optimizer Project.
            after: Inclusive lower bound on ``created_at``.
            before: Exclusive upper bound on ``created_at``.
            bucket_seconds: Bucket width in seconds.

        Returns:
            Non-empty buckets in ascending time order.
        """
        result = self._client.rpc(
            "list_serving_request_buckets",
            {
                "in_org": org_id,
                "in_endpoint": endpoint_id,
                "in_project": project_id,
                "in_after": after,
                "in_before": before,
                "in_bucket_seconds": bucket_seconds,
            },
        ).execute()
        return tuple(ServingRequestBucket.from_row(row) for row in result_rows(result))

    def endpoint_usage(self, org_id: str, endpoint_id: str) -> tuple[EndpointModelUsageRow, ...]:
        """Token totals and the routed-model mix for one endpoint, busiest model first.

        Args:
            org_id: Owning organization identifier.
            endpoint_id: The endpoint whose traffic is rolled up.

        Returns:
            One row per routed model that has served (or errored) traffic.
        """
        result = self._client.rpc(
            "endpoint_usage_rollup", {"in_org": org_id, "in_endpoint": endpoint_id}
        ).execute()
        return tuple(EndpointModelUsageRow.from_row(row) for row in result_rows(result))

    def usage_timeseries(
        self,
        org_id: str,
        endpoint_id: str,
        *,
        after: str | None = None,
        bucket_seconds: int = 86_400,
    ) -> tuple[EndpointUsageBucketRow, ...]:
        """Per-(model, bucket) usage for one endpoint, ascending time order.

        Args:
            org_id: Owning organization identifier.
            endpoint_id: The endpoint whose traffic is bucketed.
            after: Inclusive lower bound on ``created_at``.
            bucket_seconds: Bucket width in seconds.

        Returns:
            Non-empty (model, bucket) cells.
        """
        result = self._client.rpc(
            "endpoint_usage_timeseries",
            {
                "in_org": org_id,
                "in_endpoint": endpoint_id,
                "in_after": after,
                "in_bucket_seconds": bucket_seconds,
            },
        ).execute()
        return tuple(EndpointUsageBucketRow.from_row(row) for row in result_rows(result))

    def endpoints(self, org_id: str) -> tuple[ServingEndpointRecord, ...]:
        """List endpoints that have served traffic, most recent first.

        An empty result is the "nothing served yet" gate for the Telemetry
        surface.

        Args:
            org_id: Owning organization identifier.

        Returns:
            Endpoint roll-ups.
        """
        result = self._client.rpc("list_serving_endpoints", {"in_org": org_id}).execute()
        return tuple(ServingEndpointRecord.from_row(row) for row in result_rows(result))
