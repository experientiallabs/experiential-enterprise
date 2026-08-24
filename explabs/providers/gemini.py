# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Gemini key verification: the AI Studio models listing with ``?key=``.

Live-tested (2026-08-19): a bad key answers HTTP **400** (not 401) with
``error.details[].reason == "API_KEY_INVALID"`` — matched explicitly so an
unrelated 400 is not misread as a bad key.
"""

from __future__ import annotations

import httpx

from explabs.db.stores.provider_connection_store import ConnectionStatus
from explabs.providers.accounts import (
    ProbeDetail,
    ProbeResult,
    json_object,
    masked,
    probe_client,
    rate_limited,
    response_json,
    response_message,
    server_error,
    unreachable,
)
from explabs.providers.spend import SpendReport, SpendReportKind

_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"


def probe(  # noqa: PLR0911 - one verdict ladder; each branch is a distinct verdict
    credential: str, *, transport: httpx.BaseTransport | None = None
) -> ProbeResult:
    """Verify one Gemini (AI Studio) API key against the models listing."""
    try:
        with probe_client(transport) as client:
            response = client.get(_MODELS_URL, params={"pageSize": 2, "key": credential})
    except httpx.HTTPError as error:
        return unreachable("Google Gemini", error)

    if response.is_success:
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                remediation="The Gemini key works: the account's model list is readable.",
            ),
        )

    message = response_message(response)
    reasons = _error_detail_reasons(response)
    google_status = _error_status(response)
    if response.status_code == 400 and "API_KEY_INVALID" in reasons:
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=400,
                provider_code="API_KEY_INVALID",
                provider_message=message,
                remediation=(
                    f"Google rejected the key ending {masked(credential)} as not a valid "
                    "AI Studio API key (Gemini answers 400, not 401, for this). Create or "
                    "copy a key at aistudio.google.com → Get API key and save again."
                ),
            ),
        )
    if response.status_code == 429:
        # Gemini spells exhausted free-tier quota RESOURCE_EXHAUSTED on 429;
        # that is the account out of quota, not transient throttling.
        if google_status == "RESOURCE_EXHAUSTED" and "quota" in (message or "").lower():
            return ProbeResult(
                status=ConnectionStatus.QUOTA_EXHAUSTED,
                detail=ProbeDetail(
                    provider_status=429,
                    provider_code=google_status,
                    provider_message=message,
                    remediation=(
                        "The Gemini key is accepted but its quota is exhausted. Raise the "
                        "quota or enable billing on the Google Cloud project behind the "
                        "key, then traffic flows without reconnecting."
                    ),
                ),
            )
        return rate_limited("Google Gemini", response)
    if response.status_code >= 500:
        return server_error("Google Gemini", response)
    return ProbeResult(
        status=ConnectionStatus.INVALID,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_code=google_status,
            provider_message=message,
            remediation=(
                f"Google refused the key ending {masked(credential)} with HTTP "
                f"{response.status_code}. Check that the key is an AI Studio key and that "
                "the Generative Language API is enabled for its project."
            ),
        ),
    )


def _error_detail_reasons(response: httpx.Response) -> frozenset[str]:
    """Every ``error.details[].reason`` string in a Google error body."""
    error = _error_object(response)
    if error is None:
        return frozenset()
    details = error.get("details")
    if not isinstance(details, list):
        return frozenset()
    reasons: set[str] = set()
    for raw_entry in details:
        entry = json_object(raw_entry)
        if entry is None:
            continue
        reason = entry.get("reason")
        if isinstance(reason, str) and reason:
            reasons.add(reason)
    return frozenset(reasons)


def _error_status(response: httpx.Response) -> str | None:
    """Google's symbolic ``error.status`` (e.g. RESOURCE_EXHAUSTED), if any."""
    error = _error_object(response)
    if error is None:
        return None
    status = error.get("status")
    return status if isinstance(status, str) and status else None


def _error_object(response: httpx.Response) -> dict[str, object] | None:
    """The ``error`` object of a Google error body, if one exists."""
    payload = response_json(response)
    if payload is None:
        return None
    return json_object(payload.get("error"))


def spend() -> SpendReport:
    """Gemini's honest empty state: AI Studio keys expose no billing at all.

    Live-verified 2026-08-19: there is nothing programmatic to read — no cost
    endpoint, no credits endpoint — so this never calls Google. The
    self-reported gauge is the only number a Gemini connection can show.
    """
    return SpendReport(
        kind=SpendReportKind.NOT_REPORTABLE,
        message=(
            "Google doesn't expose billing for AI Studio keys — no spend, "
            "credits, or limits can be read for this connection. Use the "
            "self-reported gauge to track remaining credit."
        ),
    )
