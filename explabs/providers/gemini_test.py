# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Gemini probe verdicts against recorded provider responses."""

from __future__ import annotations

from collections.abc import Mapping

import httpx

from explabs.db.stores.provider_connection_store import ConnectionStatus
from explabs.providers import gemini
from explabs.providers.spend import SpendReportKind

KEY = "AIzaSyTestKey1234"


def _transport(status_code: int, payload: Mapping[str, object]) -> httpx.MockTransport:
    return httpx.MockTransport(lambda _request: httpx.Response(status_code, json=payload))


def test_a_working_key_is_valid_and_rides_the_query_string() -> None:
    """Gemini authenticates with ?key=; 200 on the models list proves it."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["key"] = request.url.params.get("key", "")
        return httpx.Response(200, json={"models": []})

    result = gemini.probe(KEY, transport=httpx.MockTransport(handler))
    assert result.status is ConnectionStatus.VALID
    assert seen["key"] == KEY


def test_a_bad_key_answers_400_not_401_and_is_invalid() -> None:
    """Recorded shape (live-tested): HTTP 400 with reason API_KEY_INVALID."""
    payload = {
        "error": {
            "code": 400,
            "message": "API key not valid. Please pass a valid API key.",
            "status": "INVALID_ARGUMENT",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    "reason": "API_KEY_INVALID",
                    "domain": "googleapis.com",
                    "metadata": {"service": "generativelanguage.googleapis.com"},
                }
            ],
        }
    }
    result = gemini.probe(KEY, transport=_transport(400, payload))
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_code == "API_KEY_INVALID"
    assert result.detail.provider_message == "API key not valid. Please pass a valid API key."
    assert "aistudio.google.com" in result.detail.remediation


def test_an_unrelated_400_is_not_misread_as_a_bad_key() -> None:
    """Only the API_KEY_INVALID reason means the credential is wrong.

    Other 400s surface the provider's words without the bad-key remediation.
    """
    payload = {
        "error": {"code": 400, "message": "pageSize out of range", "status": "INVALID_ARGUMENT"}
    }
    result = gemini.probe(KEY, transport=_transport(400, payload))
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_code == "INVALID_ARGUMENT"
    assert "aistudio.google.com" not in result.detail.remediation


def test_exhausted_quota_is_quota_exhausted() -> None:
    """429 RESOURCE_EXHAUSTED with a quota message means the account is out."""
    payload = {
        "error": {
            "code": 429,
            "message": "You exceeded your current quota. Please migrate to a paid plan.",
            "status": "RESOURCE_EXHAUSTED",
        }
    }
    result = gemini.probe(KEY, transport=_transport(429, payload))
    assert result.status is ConnectionStatus.QUOTA_EXHAUSTED


def test_plain_throttling_is_rate_limited() -> None:
    """A 429 without quota language keeps the key acceptable."""
    payload = {"error": {"code": 429, "message": "Rate limited.", "status": "UNAVAILABLE"}}
    result = gemini.probe(KEY, transport=_transport(429, payload))
    assert result.status is ConnectionStatus.RATE_LIMITED


def test_a_provider_5xx_is_their_outage() -> None:
    """5xx must not mark the key bad."""
    payload = {"error": {"code": 500, "message": "Internal error", "status": "INTERNAL"}}
    result = gemini.probe(KEY, transport=_transport(500, payload))
    assert result.status is ConnectionStatus.PROVIDER_ERROR


def test_an_unreachable_provider_is_provider_error() -> None:
    """Network failure means our check failed, not their credential."""

    def raise_connect_error(request: httpx.Request) -> httpx.Response:
        msg = "dns failure"
        raise httpx.ConnectError(msg, request=request)

    result = gemini.probe(KEY, transport=httpx.MockTransport(raise_connect_error))
    assert result.status is ConnectionStatus.PROVIDER_ERROR


def test_spend_is_honestly_not_reportable() -> None:
    """AI Studio keys expose no billing; the state says so and names the gauge."""
    report = gemini.spend()
    assert report.kind is SpendReportKind.NOT_REPORTABLE
    assert "Google doesn't expose billing" in report.message
    assert "self-reported" in report.message
    assert report.spend_usd is None
    assert report.credits_remaining_usd is None
