# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for WMO-free preserved serving-request response builders."""

from __future__ import annotations

from explabs.api.historical_serving import (
    MECHANISM_FIELDS,
    serving_bucket_view,
    serving_endpoint_view,
    serving_request_audit_view,
    serving_request_detail_view,
    serving_request_view,
    serving_stats_view,
)
from explabs.db.stores.serving_request_store import (
    ServingEndpointRecord,
    ServingRequestBucket,
    ServingRequestListItem,
    ServingRequestRecord,
    ServingRequestStats,
)


def _record() -> ServingRequestRecord:
    """Return a full request carrying every routing-mechanism field."""
    return ServingRequestRecord.model_validate(
        {
            "id": "aaaa0000-0000-4000-8000-000000000001",
            "org_id": "org-1",
            "endpoint_id": "endpoint-1",
            "endpoint_label": "support-prod",
            "model": "claude-haiku-4-5",
            "provider_model": "us.anthropic.claude-haiku-4-5-v1:0",
            "cluster_id": "3",
            "cluster_label": "billing-questions",
            "routing_reason": "cheapest model above the quality floor",
            "router_cost_usd": 0.0,
            "leg": "serving",
            "provider_connection_id": "connection-1",
            "byok": True,
            "input_tokens": 1_200,
            "output_tokens": 300,
            "cached_tokens": 400,
            "cost_usd": 0.003,
            "latency_ms": 310,
            "ttfb_ms": 90,
            "status": "ok",
            "error_message": None,
            "request": {"messages": [{"role": "user", "content": "hi"}]},
            "response": {"choices": [{"message": {"content": "hello"}}]},
            "created_at": "2026-07-27T10:00:00+00:00",
        }
    )


def test_detail_and_audit_partition_tenant_content_from_mechanism() -> None:
    """Tenant detail hides routing mechanism; operator audit sees it, bodies excluded.

    ``model`` is deliberately on the tenant side: the gateway-launch
    reclassification made the serving model customer-visible ("we should not
    hide it for them"), while the mechanism behind it (provider runtime id,
    cluster, reason, router cost, leg) stays operator-only.
    """
    record = _record()
    detail = serving_request_detail_view(record)
    audit = serving_request_audit_view(record)
    stored = set(record.model_dump())

    tenant_columns = set(detail) - {"frontier_cost_usd"}
    assert tenant_columns.isdisjoint(MECHANISM_FIELDS)
    assert tenant_columns | MECHANISM_FIELDS == stored
    assert detail["model"] == "claude-haiku-4-5"
    assert "model" not in MECHANISM_FIELDS
    for hidden in ("provider_model", "cluster_id", "routing_reason", "router_cost_usd"):
        assert hidden in MECHANISM_FIELDS
        assert hidden not in detail
    assert set(audit) >= MECHANISM_FIELDS
    assert {"request", "response"}.isdisjoint(audit)
    assert detail["request"] is not None
    assert detail["byok"] is True


class _FutureRequestRecord(ServingRequestRecord):
    """Represent a future persistence column not yet tenant-approved."""

    compression_ratio: float | None = None


def test_future_columns_default_private_for_tenants_and_visible_to_auditors() -> None:
    """The tenant allowlist fails closed while the operator audit remains complete."""
    record = _FutureRequestRecord.model_validate(
        {**_record().model_dump(), "compression_ratio": 0.42}
    )

    assert "compression_ratio" not in serving_request_detail_view(record)
    assert serving_request_audit_view(record)["compression_ratio"] == 0.42


def test_list_and_aggregate_views_preserve_wire_shapes() -> None:
    """List, stats, bucket, and endpoint projections remain unchanged."""
    record = _record()
    list_item = ServingRequestListItem.model_validate(record.model_dump())
    listed = serving_request_view(list_item)
    assert listed["frontier_cost_usd"] == 0.0234
    assert MECHANISM_FIELDS.isdisjoint(listed)
    assert {"request", "response"}.isdisjoint(listed)

    stats = ServingRequestStats(
        request_count=2,
        error_count=1,
        unpriced_count=0,
        cost_usd_total=0.003,
        input_tokens_total=1_200,
        output_tokens_total=300,
        cached_tokens_total=400,
    )
    bucket = ServingRequestBucket(
        bucket_start="2026-07-27T10:00:00+00:00",
        request_count=2,
        error_count=1,
    )
    endpoint = ServingEndpointRecord(
        endpoint_id="endpoint-1",
        endpoint_label="support-prod",
        request_count=2,
        last_at="2026-07-27T10:00:00+00:00",
    )
    assert serving_stats_view(stats) == stats.model_dump(mode="json")
    assert serving_bucket_view(bucket) == bucket.model_dump(mode="json")
    assert serving_endpoint_view(endpoint) == endpoint.model_dump(mode="json")
