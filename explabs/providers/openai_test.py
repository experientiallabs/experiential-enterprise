# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""OpenAI probe verdicts against recorded provider responses."""

from __future__ import annotations

from collections.abc import Mapping

import httpx
import pytest

from explabs.db.stores.provider_connection_store import ConnectionStatus
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers import openai
from explabs.providers.spend import SpendReportKind

KEY = "sk-live-test-key-abcd"


def _transport(status_code: int, payload: Mapping[str, object]) -> httpx.MockTransport:
    return httpx.MockTransport(lambda _request: httpx.Response(status_code, json=payload))


def test_a_working_key_is_valid() -> None:
    """200 on the models list proves the key."""
    result = openai.probe(KEY, transport=_transport(200, {"object": "list", "data": []}))
    assert result.status is ConnectionStatus.VALID


def test_a_rejected_key_is_invalid_with_the_provider_message() -> None:
    """Recorded shape: 401 invalid_api_key."""
    payload = {
        "error": {
            "message": "Incorrect API key provided: sk-live-***abcd.",
            "type": "invalid_request_error",
            "param": None,
            "code": "invalid_api_key",
        }
    }
    result = openai.probe(KEY, transport=_transport(401, payload))
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_code == "invalid_api_key"
    assert result.detail.provider_message == "Incorrect API key provided: sk-live-***abcd."
    assert "platform.openai.com" in result.detail.remediation


def test_a_deactivated_account_reads_differently_than_a_bad_key() -> None:
    """A deactivated account is a different problem (and fix) than a bad key.

    Recorded shape (live-tested): 401 with error.code account_deactivated.
    """
    payload = {
        "error": {
            "message": "This account has been deactivated.",
            "type": "invalid_request_error",
            "param": None,
            "code": "account_deactivated",
        }
    }
    result = openai.probe(KEY, transport=_transport(401, payload))
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_code == "account_deactivated"
    assert "deactivated" in result.detail.remediation
    # The fix is the account, not the key string.
    assert "active account" in result.detail.remediation


def test_out_of_quota_is_quota_exhausted_not_rate_limited() -> None:
    """OpenAI spells "out of credit" as a 429 with insufficient_quota."""
    payload = {
        "error": {
            "message": "You exceeded your current quota, please check your plan and billing details.",
            "type": "insufficient_quota",
            "param": None,
            "code": "insufficient_quota",
        }
    }
    result = openai.probe(KEY, transport=_transport(429, payload))
    assert result.status is ConnectionStatus.QUOTA_EXHAUSTED
    assert "Billing" in result.detail.remediation


def test_plain_throttling_is_rate_limited() -> None:
    """A rate-limit 429 keeps the key acceptable."""
    payload = {
        "error": {
            "message": "Rate limit reached for requests.",
            "type": "requests",
            "code": "rate_limit_exceeded",
        }
    }
    result = openai.probe(KEY, transport=_transport(429, payload))
    assert result.status is ConnectionStatus.RATE_LIMITED


def test_a_provider_5xx_is_their_outage_not_the_key() -> None:
    """5xx must not mark a customer's key bad."""
    result = openai.probe(KEY, transport=_transport(500, {"error": {"message": "server_error"}}))
    assert result.status is ConnectionStatus.PROVIDER_ERROR
    assert "not your key" in result.detail.remediation


def test_an_unreachable_provider_is_provider_error() -> None:
    """Network failure means our check failed, not their credential."""

    def raise_connect_error(request: httpx.Request) -> httpx.Response:
        msg = "connection refused"
        raise httpx.ConnectError(msg, request=request)

    result = openai.probe(KEY, transport=httpx.MockTransport(raise_connect_error))
    assert result.status is ConnectionStatus.PROVIDER_ERROR
    assert result.detail.provider_code == "ConnectError"


def test_no_verdict_ever_carries_the_credential() -> None:
    """Only the masked last4 may appear in any detail field."""
    payload = {"error": {"message": "bad", "code": "invalid_api_key"}}
    result = openai.probe(KEY, transport=_transport(401, payload))
    assert KEY not in result.model_dump_json()
    assert "abcd" in result.detail.remediation


ADMIN_KEY = "sk-admin-spend-key-efgh"

# The documented organization-costs bucket shape (UNTESTED live: no working
# admin key on this machine; written from the API docs).
COSTS_PAYLOAD = {
    "object": "page",
    "data": [
        {
            "object": "bucket",
            "start_time": 1_754_006_400,
            "end_time": 1_754_092_800,
            "results": [
                {
                    "object": "organization.costs.result",
                    "amount": {"value": 0.06, "currency": "usd"},
                    "line_item": None,
                    "project_id": None,
                }
            ],
        },
        {
            "object": "bucket",
            "start_time": 1_754_092_800,
            "end_time": 1_754_179_200,
            "results": [
                {
                    "object": "organization.costs.result",
                    "amount": {"value": 12.5, "currency": "usd"},
                    "line_item": None,
                    "project_id": None,
                }
            ],
        },
    ],
    "has_more": False,
    "next_page": None,
}


def test_probe_names_an_admin_key_in_the_main_slot() -> None:
    """Admin keys cannot serve inference; the verdict names both key types."""
    result = openai.probe(ADMIN_KEY)
    assert result.status is ConnectionStatus.INVALID
    assert "sk-admin-" in result.detail.remediation
    assert "admin-key slot" in result.detail.remediation


def test_probe_spend_key_names_an_inference_key_in_the_admin_slot() -> None:
    """Both key types are named so the user knows which slot each belongs in."""
    result = openai.probe_spend_key(KEY)
    assert result.status is ConnectionStatus.INVALID
    assert "sk-admin-" in result.detail.remediation
    assert "api.usage.read" in result.detail.remediation


def test_probe_spend_key_accepts_a_working_admin_key() -> None:
    """200 on organization costs proves the admin key can read spend."""
    result = openai.probe_spend_key(ADMIN_KEY, transport=_transport(200, COSTS_PAYLOAD))
    assert result.status is ConnectionStatus.VALID


def test_probe_spend_key_rejection_is_invalid() -> None:
    """A revoked admin key gets the provider's own words back."""
    payload = {"error": {"message": "Invalid authorization header", "code": "invalid_api_key"}}
    result = openai.probe_spend_key(ADMIN_KEY, transport=_transport(401, payload))
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_code == "invalid_api_key"


def test_spend_without_an_admin_key_is_the_honest_empty_state() -> None:
    """No admin key stored → connect-an-admin-key, never a guessed number."""
    report = openai.spend(None)
    assert report.kind is SpendReportKind.NOT_REPORTABLE
    assert "admin key" in report.message
    assert "api.usage.read" in report.message


def test_spend_refuses_an_inference_key_naming_both_types() -> None:
    """A wrong-type stored credential is a loud read failure, not a 401 mystery."""
    report = openai.spend(KEY)
    assert report.kind is SpendReportKind.READ_FAILED
    assert "sk-admin-" in report.message


def test_spend_sums_documented_bucket_amounts() -> None:
    """Docs shape: results[].amount.value dollars, summed across buckets."""
    report = openai.spend(ADMIN_KEY, transport=_transport(200, COSTS_PAYLOAD))
    assert report.kind is SpendReportKind.REPORTED
    assert report.source is SnapshotSource.PROVIDER_API
    assert report.spend_usd == pytest.approx(12.56)
    assert report.detail is not None
    assert report.detail["daily_buckets"] == 2


def test_spend_read_failure_keeps_stored_numbers() -> None:
    """A refused read reports the provider's words instead of inventing zeros."""
    payload = {"error": {"message": "insufficient permissions", "code": "missing_scope"}}
    report = openai.spend(ADMIN_KEY, transport=_transport(403, payload))
    assert report.kind is SpendReportKind.READ_FAILED
    assert "insufficient permissions" in report.message
