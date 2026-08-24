# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""OpenRouter key verification and spend reads: ``/api/v1/key`` + ``/api/v1/credits``.

Live-tested (2026-08-19): the key endpoint doubles as validation AND returns
the key's limit/usage figures, which ride the verdict's payload for the spend
adapters. 402 means the account is out of credits — a working key that cannot
buy inference. OpenRouter is the only provider with a real remaining-balance
API: ``/api/v1/credits`` returns ``{total_credits, total_usage}`` and
remaining is the difference (live-tested 2026-08-19).
"""

from __future__ import annotations

import httpx

from explabs.db.repositories import JsonObject
from explabs.db.stores.provider_connection_store import ConnectionStatus
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers import spend as spend_contract
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

_KEY_URL = "https://openrouter.ai/api/v1/key"
_CREDITS_URL = "https://openrouter.ai/api/v1/credits"


def probe(  # noqa: PLR0911 - one verdict ladder; each branch is a distinct verdict
    credential: str, *, transport: httpx.BaseTransport | None = None
) -> ProbeResult:
    """Verify one OpenRouter key against its own key-status endpoint."""
    try:
        with probe_client(transport) as client:
            response = client.get(_KEY_URL, headers={"Authorization": f"Bearer {credential}"})
    except httpx.HTTPError as error:
        return unreachable("OpenRouter", error)

    if response.is_success:
        payload = response_json(response)
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                remediation="The OpenRouter key works and reports its own limit and usage.",
                # The same read the spend adapters use: limit, limit_remaining,
                # usage, and the daily/weekly/monthly usage figures.
                provider_payload=json_object(payload.get("data")) if payload is not None else None,
            ),
        )

    message = response_message(response)
    if response.status_code == 401:
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=401,
                provider_message=message,
                remediation=(
                    f"OpenRouter rejected the key ending {masked(credential)}. Paste a "
                    "current key (sk-or-…) from openrouter.ai → Keys and save again."
                ),
            ),
        )
    if response.status_code == 402:
        return ProbeResult(
            status=ConnectionStatus.QUOTA_EXHAUSTED,
            detail=ProbeDetail(
                provider_status=402,
                provider_message=message,
                remediation=(
                    "The OpenRouter key is accepted but the account has insufficient "
                    "credits. Top up at openrouter.ai → Credits; traffic then flows "
                    "without reconnecting the key."
                ),
            ),
        )
    if response.status_code == 429:
        return rate_limited("OpenRouter", response)
    if response.status_code >= 500:
        return server_error("OpenRouter", response)
    return ProbeResult(
        status=ConnectionStatus.INVALID,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_message=message,
            remediation=(
                f"OpenRouter refused the key ending {masked(credential)} with HTTP "
                f"{response.status_code}. Check the key at openrouter.ai → Keys."
            ),
        ),
    )


def spend(credential: str, *, transport: httpx.BaseTransport | None = None) -> SpendReport:
    """Read one OpenRouter account's spend, credits, and key limit.

    Two calls, both live-tested 2026-08-19: ``/api/v1/key`` for the key's
    limit and monthly usage, ``/api/v1/credits`` for the account balance
    (``total_credits - total_usage``, floored at zero — usage can briefly
    exceed purchased credits).

    OpenRouter's current docs restrict ``/api/v1/credits`` to management
    (provisioning) keys, answering 403 for inference keys (some accounts
    still allow it — ours did on 2026-08-19). A 403 there therefore degrades
    to the key-level figures instead of failing the whole read: the sweep
    keeps reporting spend and limits, just without the account balance.
    """
    headers = {"Authorization": f"Bearer {credential}"}
    try:
        with probe_client(transport) as client:
            key_response = client.get(_KEY_URL, headers=headers)
            credits_response = client.get(_CREDITS_URL, headers=headers)
    except httpx.HTTPError as error:
        return spend_contract.unreachable("OpenRouter", error)
    if not key_response.is_success:
        return spend_contract.read_failed(
            "OpenRouter",
            status=key_response.status_code,
            message=response_message(key_response),
        )
    credits_forbidden = credits_response.status_code == 403
    if not credits_response.is_success and not credits_forbidden:
        return spend_contract.read_failed(
            "OpenRouter",
            status=credits_response.status_code,
            message=response_message(credits_response),
        )

    key_data = _data_object(key_response)
    credits_data = {} if credits_forbidden else _data_object(credits_response)
    spend_usd = _figure(key_data, "usage_monthly")
    usage_limit = _figure(key_data, "limit")
    total_credits = _figure(credits_data, "total_credits")
    total_usage = _figure(credits_data, "total_usage")
    remaining = (
        max(0.0, total_credits - total_usage)
        if total_credits is not None and total_usage is not None
        else None
    )
    return SpendReport(
        kind=SpendReportKind.REPORTED,
        source=SnapshotSource.PROVIDER_API,
        spend_usd=spend_usd,
        credits_remaining_usd=remaining,
        usage_limit_usd=usage_limit,
        detail={
            # The key's own figures; limit_reset says what window the limit
            # covers ("daily" on our live account), so the UI can label it.
            "limit_remaining": _figure(key_data, "limit_remaining"),
            "limit_reset": key_data.get("limit_reset"),
            "usage_total": _figure(key_data, "usage"),
            "byok_usage_monthly": _figure(key_data, "byok_usage_monthly"),
            "total_credits": total_credits,
            "total_usage": total_usage,
            "credits_forbidden": credits_forbidden,
        },
        message=(
            "OpenRouter restricts the credits balance to management keys; this "
            "key reports its own usage and limit only."
            if credits_forbidden
            else "OpenRouter reports this account's credits and this key's usage directly."
        ),
    )


def _data_object(response: httpx.Response) -> JsonObject:
    """The ``data`` object both OpenRouter endpoints wrap their payload in."""
    payload = response_json(response)
    if payload is None:
        return {}
    return json_object(payload.get("data")) or {}


def _figure(payload: JsonObject, field: str) -> float | None:
    """One numeric field, or None where OpenRouter sent null/absent."""
    value = payload.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
