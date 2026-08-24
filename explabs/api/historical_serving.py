# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""WMO-free response builders for preserved serving-request history."""

from __future__ import annotations

from explabs.db.repositories import JsonObject
from explabs.db.stores.serving_request_store import (
    ServingEndpointRecord,
    ServingRequestBucket,
    ServingRequestListItem,
    ServingRequestRecord,
    ServingRequestStats,
)
from explabs.frontier_pricing import frontier_cost_usd

# Tenant detail is an allowlist: any future persistence column is private
# until explicitly classified and approved for this response. `model` is an
# approved tenant field (the gateway-launch reclassification: customers see
# which model served each call); the row's other routing fields stay below.
TENANT_DETAIL_FIELDS = frozenset(
    {
        "id",
        "org_id",
        "endpoint_id",
        "endpoint_label",
        "project_id",
        "billing_source",
        "billing_components",
        "model",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "cost_usd",
        "byok",
        "latency_ms",
        "ttfb_ms",
        "status",
        "error_message",
        "request",
        "response",
        "created_at",
    }
)

# These fields explain the routing MECHANISM (why the call routed where it
# did, and through which provider runtime) and remain operator-only. The set
# is exported so tests fail when the persisted row gains an unclassified
# field or a tenant serializer begins exposing one.
MECHANISM_FIELDS = frozenset(
    {
        "provider_model",
        "cluster_id",
        "cluster_label",
        "routing_reason",
        "router_cost_usd",
        "leg",
        "provider_connection_id",
    }
)


def serving_request_view(item: ServingRequestListItem) -> JsonObject:
    """Project a lightweight request row and its frontier comparison."""
    payload = item.model_dump(mode="json")
    payload["frontier_cost_usd"] = _frontier_comparison(
        project_id=item.project_id,
        status=item.status,
        input_tokens=item.input_tokens,
        output_tokens=item.output_tokens,
        cached_tokens=item.cached_tokens,
    )
    return payload


def serving_request_detail_view(record: ServingRequestRecord) -> JsonObject:
    """Project tenant-visible outcomes and stored bodies, excluding mechanism."""
    payload = record.model_dump(mode="json", include=set(TENANT_DETAIL_FIELDS))
    payload["frontier_cost_usd"] = _frontier_comparison(
        project_id=record.project_id,
        status=record.status,
        input_tokens=record.input_tokens,
        output_tokens=record.output_tokens,
        cached_tokens=record.cached_tokens,
    )
    return payload


def _frontier_comparison(
    *,
    project_id: str | None,
    status: str,
    input_tokens: int,
    output_tokens: int,
    cached_tokens: int,
) -> float | None:
    """Price only observed Chat usage against the frontier comparison.

    Project error rows may carry a conservative candidate reservation after
    ambiguous provider outcomes. Their token ceiling is accounting evidence,
    not observed Chat usage, so presenting a frontier estimate would invent a
    savings comparison. Successful Project rows and every legacy row retain
    the existing comparison.

    Args:
        project_id: Project identity for new routed rows, otherwise ``None``.
        status: Persisted terminal status.
        input_tokens: Candidate Chat input tokens or legacy input tokens.
        output_tokens: Candidate Chat output tokens or legacy output tokens.
        cached_tokens: Candidate Chat cached tokens or legacy cached tokens.

    Returns:
        Frontier comparison, or ``None`` for Project error reservations.
    """
    if project_id is not None and status != "ok":
        return None
    return frontier_cost_usd(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_tokens=cached_tokens,
    )


def serving_request_audit_view(record: ServingRequestRecord) -> JsonObject:
    """Project the operator audit row while omitting tenant message bodies."""
    return record.model_dump(mode="json", exclude={"request", "response"})


def serving_stats_view(stats: ServingRequestStats) -> JsonObject:
    """Project window aggregates without deriving a frontier comparison."""
    return stats.model_dump(mode="json")


def serving_bucket_view(bucket: ServingRequestBucket) -> JsonObject:
    """Project one activity-chart bucket."""
    return bucket.model_dump(mode="json")


def serving_endpoint_view(record: ServingEndpointRecord) -> JsonObject:
    """Project one served-endpoint rollup."""
    return record.model_dump(mode="json")
