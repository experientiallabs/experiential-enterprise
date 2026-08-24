# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Anthropic probe verdicts against recorded provider responses."""

from __future__ import annotations

from collections.abc import Mapping

import httpx
import pytest

from explabs.db.stores.provider_connection_store import ConnectionStatus
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers import anthropic
from explabs.providers.spend import SpendReportKind

KEY = "sk-ant-api03-inference-key-wxyz"
ADMIN_KEY = "sk-ant-admin01-spend-key-abcd"


def _transport(status_code: int, payload: Mapping[str, object]) -> httpx.MockTransport:
    return httpx.MockTransport(lambda _request: httpx.Response(status_code, json=payload))


def test_a_working_key_is_valid_and_sends_the_version_header() -> None:
    """200 on the models list proves the key; the API requires the version header."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(
            {
                "x-api-key": request.headers.get("x-api-key", ""),
                "anthropic-version": request.headers.get("anthropic-version", ""),
            }
        )
        return httpx.Response(200, json={"data": [], "has_more": False})

    result = anthropic.probe(KEY, transport=httpx.MockTransport(handler))
    assert result.status is ConnectionStatus.VALID
    assert seen["x-api-key"] == KEY
    assert seen["anthropic-version"] == "2023-06-01"


def test_a_rejected_key_is_invalid() -> None:
    """Recorded shape: 401 authentication_error."""
    payload = {
        "type": "error",
        "error": {"type": "authentication_error", "message": "invalid x-api-key"},
    }
    result = anthropic.probe(KEY, transport=_transport(401, payload))
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_message == "invalid x-api-key"
    assert "console.anthropic.com" in result.detail.remediation


def test_an_admin_key_is_named_before_any_network_call() -> None:
    """The verdict names which key kind was pasted, without a provider call.

    Live-tested: admin and inference keys are disjoint — an admin key gets 401
    on the models endpoint even though it is a real credential.
    """

    def fail(request: httpx.Request) -> httpx.Response:
        msg = "an admin key must be classified without a provider call"
        raise AssertionError(msg)

    result = anthropic.probe("sk-ant-admin01-real-admin-key", transport=httpx.MockTransport(fail))
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_code == "admin_key_in_inference_slot"
    assert "ADMIN key" in result.detail.remediation
    assert "sk-ant-api" in result.detail.remediation


def test_throttling_is_rate_limited() -> None:
    """429 keeps the key acceptable."""
    payload = {"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}
    result = anthropic.probe(KEY, transport=_transport(429, payload))
    assert result.status is ConnectionStatus.RATE_LIMITED


def test_overloaded_is_their_outage() -> None:
    """Anthropic's 529 overloaded is provider-side, not the key."""
    payload = {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
    result = anthropic.probe(KEY, transport=_transport(529, payload))
    assert result.status is ConnectionStatus.PROVIDER_ERROR


def test_an_unreachable_provider_is_provider_error() -> None:
    """Network failure means our check failed, not their credential."""

    def raise_timeout(request: httpx.Request) -> httpx.Response:
        msg = "timed out"
        raise httpx.ReadTimeout(msg, request=request)

    result = anthropic.probe(KEY, transport=httpx.MockTransport(raise_timeout))
    assert result.status is ConnectionStatus.PROVIDER_ERROR


# The recorded cost_report success body (live shape, 2026-08-19): daily
# buckets whose amounts are decimal STRINGS.
def _cost_bucket(day: str, amount: str) -> dict[str, object]:
    return {
        "starting_at": f"2026-08-{day}T00:00:00Z",
        "ending_at": f"2026-08-{day}T23:59:59Z",
        "results": [{"currency": "USD", "amount": amount, "workspace_id": None}],
    }


def test_probe_spend_key_names_an_inference_key_in_the_admin_slot() -> None:
    """Both key types are named so the user knows which slot each belongs in."""
    result = anthropic.probe_spend_key(KEY)
    assert result.status is ConnectionStatus.INVALID
    assert "sk-ant-admin" in result.detail.remediation
    assert "sk-ant-api" in result.detail.remediation
    assert "main API-key slot" in result.detail.remediation


def test_probe_spend_key_accepts_a_working_admin_key() -> None:
    """200 on cost_report proves the admin key can read spend.

    The probe must send starting_at: without it the endpoint answers 400
    "starting_at: Field required" even for a working key (live-tested).
    """
    seen: dict[str, str | None] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["starting_at"] = request.url.params.get("starting_at")
        return httpx.Response(200, json={"data": [_cost_bucket("18", "1.0")], "has_more": False})

    result = anthropic.probe_spend_key(ADMIN_KEY, transport=httpx.MockTransport(handler))
    assert result.status is ConnectionStatus.VALID
    assert seen["starting_at"], "cost_report requires starting_at"


def test_probe_spend_key_rejection_is_invalid() -> None:
    """A revoked admin key gets the provider's own words back."""
    payload = {"error": {"type": "authentication_error", "message": "invalid x-api-key"}}
    result = anthropic.probe_spend_key(ADMIN_KEY, transport=_transport(401, payload))
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_message == "invalid x-api-key"


def test_spend_without_an_admin_key_is_the_honest_empty_state() -> None:
    """No admin key stored → connect-an-admin-key, never a guessed number."""
    report = anthropic.spend(None)
    assert report.kind is SpendReportKind.NOT_REPORTABLE
    assert "admin key" in report.message
    assert report.spend_usd is None


def test_spend_refuses_an_inference_key_naming_both_types() -> None:
    """A wrong-type stored credential is a loud read failure, not a 401 mystery."""
    report = anthropic.spend(KEY)
    assert report.kind is SpendReportKind.READ_FAILED
    assert "sk-ant-admin" in report.message
    assert "sk-ant-api" in report.message


def test_spend_sums_string_amounts_in_the_configured_unit() -> None:
    """Live shape: amounts are decimal strings; the unit constant converts."""
    payload = {
        "data": [_cost_bucket("17", "293935.649715"), _cost_bucket("18", "116296.08789")],
        "has_more": False,
    }
    report = anthropic.spend(ADMIN_KEY, transport=_transport(200, payload))
    assert report.kind is SpendReportKind.REPORTED
    assert report.source is SnapshotSource.PROVIDER_API
    # The unit is behind ONE named constant, default cents, pending the product owner's
    # console check; this assertion pins today's conversion.
    assert anthropic.COST_REPORT_UNIT is anthropic.CostReportUnit.CENTS
    assert report.spend_usd == pytest.approx((293935.649715 + 116296.08789) / 100)
    assert report.detail is not None
    assert report.detail["amount_unit"] == "cents"
    assert report.detail["daily_buckets"] == 2


def test_spend_follows_cost_report_pagination() -> None:
    """A month can span pages; both pages land in one total."""
    pages = iter(
        [
            {"data": [_cost_bucket("01", "100")], "has_more": True, "next_page": "page-2"},
            {"data": [_cost_bucket("02", "50")], "has_more": False, "next_page": None},
        ]
    )
    seen_pages: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_pages.append(request.url.params.get("page"))
        return httpx.Response(200, json=next(pages))

    report = anthropic.spend(ADMIN_KEY, transport=httpx.MockTransport(handler))
    assert report.spend_usd == pytest.approx(1.5)
    assert seen_pages == [None, "page-2"]


def test_spend_read_failure_keeps_stored_numbers() -> None:
    """A refused read reports the provider's words instead of inventing zeros."""
    payload = {"error": {"type": "permission_error", "message": "not permitted"}}
    report = anthropic.spend(ADMIN_KEY, transport=_transport(403, payload))
    assert report.kind is SpendReportKind.READ_FAILED
    assert "not permitted" in report.message
