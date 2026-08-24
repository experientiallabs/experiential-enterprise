# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for bounded, region-pinned ClickHouse trace transport."""

from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from explabs.trace_acquisition.clickhouse_trace import (
    ClickHouseTraceError,
    ClickHouseTraceSettings,
    ClickHouseTraceStore,
)
from explabs.trace_acquisition.trace_normalization import normalize_trace_object

_ORG_ID = "71000000-0000-0000-0000-000000000001"
_INGEST_ID = "72000000-0000-0000-0000-000000000001"


def _settings(*, batch_bytes: int = 65_536) -> ClickHouseTraceSettings:
    """Build non-secret test settings."""
    return ClickHouseTraceSettings(
        url="https://example.us-west-2.aws.clickhouse.cloud",
        username="runtime",
        password="test-only",  # noqa: S106 - non-secret unit-test fixture
        expected_region="us-west-2",
        projection_enabled=True,
        batch_bytes=batch_bytes,
    )


def _rows(count: int = 2):  # noqa: ANN202 - inferred test helper
    """Build deterministic normalized rows."""
    content = "\n".join(json.dumps({"trace_id": f"t-{index}"}) for index in range(count))
    content_bytes = (content + "\n").encode()
    return normalize_trace_object(
        content_bytes,
        org_id=_ORG_ID,
        ingest_id=_INGEST_ID,
        source_kind="otlp",
        transport_kind="upload",
        source_label="prod",
        object_sha256=hashlib.sha256(content_bytes, usedforsecurity=False).hexdigest(),
        received_at="2026-08-22T20:00:00Z",
        projection_version=1,
        projection_attempt=1,
    )


def test_settings_are_disabled_by_default() -> None:
    """Credentials never activate trace writes without the explicit flag."""
    assert ClickHouseTraceSettings.from_env({}) is None


def test_settings_fail_closed_on_region_mismatch() -> None:
    """An enabled worker refuses a cross-region ClickHouse endpoint."""
    with pytest.raises(ValueError, match="region"):
        ClickHouseTraceSettings.from_env(
            {
                "CLICKHOUSE_TRACE_PROJECTION_ENABLED": "true",
                "CLICKHOUSE_HTTP_URL": "https://example.us-east-1.aws.clickhouse.cloud",
                "CLICKHOUSE_HTTP_USERNAME": "runtime",
                "CLICKHOUSE_HTTP_PASSWORD": "secret",
                "CLICKHOUSE_EXPECTED_REGION": "us-west-2",
            }
        )


def test_insert_uses_body_only_synchronous_batches() -> None:
    """SQL stays in query params and inserts avoid async-buffer latency."""
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        """Capture one acknowledged insert request."""
        requests.append(request)
        return httpx.Response(200, request=request)

    client = httpx.Client(
        base_url="https://example.us-west-2.aws.clickhouse.cloud/",
        transport=httpx.MockTransport(handle),
    )
    store = ClickHouseTraceStore(_settings(), http_client=client)

    store.insert(_rows())

    assert len(requests) == 1
    request = requests[0]
    assert request.url.params["query"].endswith("FORMAT JSONEachRow")
    assert "wait_for_async_insert" not in request.url.params
    assert "async_insert" not in request.url.params
    assert b"INSERT INTO" not in request.content
    assert len(request.content.splitlines()) == 2


def test_individual_row_configured_batch_limit_is_enforced() -> None:
    """An individual row cannot bypass the operator-configured request bound."""
    store = ClickHouseTraceStore(_settings(batch_bytes=100))
    with pytest.raises(ClickHouseTraceError, match="configured ClickHouse batch limit"):
        store.insert(_rows(1))


def test_count_ingest_uses_typed_tenant_and_ingest_parameters() -> None:
    """Read-back verification is tenant scoped and returns an integer count."""
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        """Return one ClickHouse JSONEachRow count."""
        requests.append(request)
        return httpx.Response(200, text='{"count()":"2"}\n', request=request)

    client = httpx.Client(
        base_url="https://example.us-west-2.aws.clickhouse.cloud/",
        transport=httpx.MockTransport(handle),
    )
    store = ClickHouseTraceStore(_settings(), http_client=client)

    assert store.count_ingest(org_id=_ORG_ID, ingest_id=_INGEST_ID, projection_version=1) == 2
    params = requests[0].url.params
    assert params["param_org_id"] == _ORG_ID
    assert params["param_ingest_id"] == _INGEST_ID
