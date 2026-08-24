# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""OpenRouter probe verdicts against recorded provider responses."""

from __future__ import annotations

from collections.abc import Mapping

import httpx
import pytest

from explabs.db.stores.provider_connection_store import ConnectionStatus
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers import openrouter
from explabs.providers.spend import SpendReportKind

KEY = "sk-or-v1-test-key-9876"

# The recorded /api/v1/key success body: validation AND the key's own
# limit/usage figures in one call.
KEY_PAYLOAD = {
    "data": {
        "label": "sk-or-v1-...9876",
        "limit": 100.0,
        "usage": 41.2,
        "limit_remaining": 58.8,
        "usage_daily": 1.1,
        "usage_weekly": 8.4,
        "usage_monthly": 41.2,
        "is_free_tier": False,
    }
}


def _transport(status_code: int, payload: Mapping[str, object]) -> httpx.MockTransport:
    return httpx.MockTransport(lambda _request: httpx.Response(status_code, json=payload))


def test_a_working_key_is_valid_and_carries_its_usage_figures() -> None:
    """The key endpoint doubles as validation and the spend adapters' read."""
    result = openrouter.probe(KEY, transport=_transport(200, KEY_PAYLOAD))
    assert result.status is ConnectionStatus.VALID
    assert result.detail.provider_payload is not None
    assert result.detail.provider_payload["limit_remaining"] == 58.8
    assert result.detail.provider_payload["usage"] == 41.2


def test_a_rejected_key_is_invalid() -> None:
    """401 means the key itself."""
    payload = {"error": {"message": "No auth credentials found", "code": 401}}
    result = openrouter.probe(KEY, transport=_transport(401, payload))
    assert result.status is ConnectionStatus.INVALID
    assert "openrouter.ai" in result.detail.remediation


def test_insufficient_credits_is_quota_exhausted() -> None:
    """Recorded shape: 402 = the account cannot buy inference."""
    payload = {"error": {"message": "Insufficient credits", "code": 402}}
    result = openrouter.probe(KEY, transport=_transport(402, payload))
    assert result.status is ConnectionStatus.QUOTA_EXHAUSTED
    assert "Top up" in result.detail.remediation


def test_throttling_is_rate_limited_and_5xx_is_their_outage() -> None:
    """429 → rate_limited; 5xx → provider_error."""
    throttled = openrouter.probe(
        KEY, transport=_transport(429, {"error": {"message": "Rate limited"}})
    )
    assert throttled.status is ConnectionStatus.RATE_LIMITED
    outage = openrouter.probe(KEY, transport=_transport(502, {"error": {"message": "bad gateway"}}))
    assert outage.status is ConnectionStatus.PROVIDER_ERROR


def test_an_unreachable_provider_is_provider_error() -> None:
    """Network failure means our check failed, not their credential."""

    def raise_connect_error(request: httpx.Request) -> httpx.Response:
        msg = "connection refused"
        raise httpx.ConnectError(msg, request=request)

    result = openrouter.probe(KEY, transport=httpx.MockTransport(raise_connect_error))
    assert result.status is ConnectionStatus.PROVIDER_ERROR


# The recorded /api/v1/credits success body (live shape, 2026-08-19).
CREDITS_PAYLOAD = {"data": {"total_credits": 150.0, "total_usage": 67.088479312}}


def _spend_transport(
    key_response: httpx.Response, credits_response: httpx.Response
) -> httpx.MockTransport:
    """Route the two spend calls by path."""

    def handle(request: httpx.Request) -> httpx.Response:
        return key_response if request.url.path == "/api/v1/key" else credits_response

    return httpx.MockTransport(handle)


def test_spend_reads_key_and_credits_into_one_report() -> None:
    """Live shapes: usage_monthly + limit off /key, remaining off /credits."""
    report = openrouter.spend(
        KEY,
        transport=_spend_transport(
            httpx.Response(200, json=KEY_PAYLOAD), httpx.Response(200, json=CREDITS_PAYLOAD)
        ),
    )
    assert report.kind is SpendReportKind.REPORTED
    assert report.source is SnapshotSource.PROVIDER_API
    assert report.spend_usd == 41.2
    assert report.usage_limit_usd == 100.0
    assert report.credits_remaining_usd == pytest.approx(150.0 - 67.088479312)
    assert report.detail is not None
    assert report.detail["limit_remaining"] == 58.8


def test_spend_floors_remaining_at_zero() -> None:
    """Usage can briefly exceed purchased credits; remaining never reads negative."""
    overdrawn = {"data": {"total_credits": 10.0, "total_usage": 12.5}}
    report = openrouter.spend(
        KEY,
        transport=_spend_transport(
            httpx.Response(200, json=KEY_PAYLOAD), httpx.Response(200, json=overdrawn)
        ),
    )
    assert report.credits_remaining_usd == 0.0


def test_spend_degrades_to_key_figures_when_credits_needs_a_management_key() -> None:
    """A 403 on /credits (management-key restriction) keeps the /key reading.

    OpenRouter's docs restrict the credits balance to provisioning keys; the
    nightly sweep must keep reporting spend and limits for inference keys
    instead of logging a failed read every tick.
    """
    forbidden = httpx.Response(
        403, json={"error": {"message": "Only management keys can perform this operation"}}
    )
    report = openrouter.spend(
        KEY, transport=_spend_transport(httpx.Response(200, json=KEY_PAYLOAD), forbidden)
    )
    assert report.kind is SpendReportKind.REPORTED
    assert report.spend_usd == 41.2
    assert report.usage_limit_usd == 100.0
    assert report.credits_remaining_usd is None
    assert report.detail is not None
    assert report.detail["credits_forbidden"] is True
    assert "management keys" in report.message


def test_spend_read_fails_honestly_on_a_rejected_key() -> None:
    """A 401 during the read is a failure verdict, never invented numbers."""
    rejected = httpx.Response(401, json={"error": {"message": "No auth credentials found"}})
    report = openrouter.spend(KEY, transport=_spend_transport(rejected, rejected))
    assert report.kind is SpendReportKind.READ_FAILED
    assert "401" in report.message


def test_spend_read_fails_honestly_when_unreachable() -> None:
    """Network failure keeps the stored numbers and says the read failed."""

    def raise_connect_error(request: httpx.Request) -> httpx.Response:
        msg = "connection refused"
        raise httpx.ConnectError(msg, request=request)

    report = openrouter.spend(KEY, transport=httpx.MockTransport(raise_connect_error))
    assert report.kind is SpendReportKind.READ_FAILED
    assert "unchanged" in report.message
