# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""OpenAI key verification: ``GET /v1/models`` with the bearer key.

Live-tested error shapes (2026-08-19): a deactivated account answers 401 with
``error.code == "account_deactivated"`` — a different problem (and different
fix) than a plain bad key, so the two verdicts read differently.
"""

from __future__ import annotations

import time

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
    response_error_field,
    response_message,
    server_error,
    unreachable,
)
from explabs.providers.spend import SpendReport, SpendReportKind, month_to_date_start

_MODELS_URL = "https://api.openai.com/v1/models"
_COSTS_URL = "https://api.openai.com/v1/organization/costs"

# OpenAI spells "out of credit" as a 429, distinct from throttling.
_QUOTA_CODES = frozenset({"insufficient_quota", "billing_hard_limit_reached"})

# The org-admin key namespace (scope api.usage.read reads billing); admin and
# inference keys are disjoint, mirroring Anthropic's split.
ADMIN_KEY_PREFIX = "sk-admin-"

# /v1/organization/costs pages by daily bucket; a month is at most 31.
_MAX_COSTS_PAGES = 4


def probe(  # noqa: PLR0911 - one verdict ladder; each branch is a distinct verdict
    credential: str, *, transport: httpx.BaseTransport | None = None
) -> ProbeResult:
    """Verify one OpenAI API key against the models listing."""
    if credential.startswith(ADMIN_KEY_PREFIX):
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code="admin_key_in_inference_slot",
                remediation=(
                    f"The key ending {masked(credential)} is an OpenAI ADMIN key "
                    "(sk-admin-…). Admin keys manage the organization and read usage "
                    "but do not serve inference — the two key types are disjoint. "
                    "Paste a project API key (sk-…) from platform.openai.com → API "
                    "keys here; the admin key belongs in the optional admin-key slot."
                ),
            ),
        )
    try:
        with probe_client(transport) as client:
            response = client.get(_MODELS_URL, headers={"Authorization": f"Bearer {credential}"})
    except httpx.HTTPError as error:
        return unreachable("OpenAI", error)

    if response.is_success:
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                remediation="The OpenAI key works: the account's model list is readable.",
            ),
        )

    code = response_error_field(response, "code")
    message = response_message(response)
    if response.status_code == 401:
        if code == "account_deactivated":
            return ProbeResult(
                status=ConnectionStatus.INVALID,
                detail=ProbeDetail(
                    provider_status=401,
                    provider_code=code,
                    provider_message=message,
                    remediation=(
                        f"OpenAI reports the account behind the key ending {masked(credential)} "
                        "as deactivated — the key format is fine, the account is closed. "
                        "Reactivate the account with OpenAI support or paste a key from an "
                        "active account."
                    ),
                ),
            )
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=401,
                provider_code=code,
                provider_message=message,
                remediation=(
                    f"OpenAI rejected the key ending {masked(credential)}. Paste a current "
                    "secret key (sk-…) from platform.openai.com → API keys and save again."
                ),
            ),
        )
    if response.status_code == 429:
        error_type = response_error_field(response, "type")
        if code in _QUOTA_CODES or error_type in _QUOTA_CODES:
            return ProbeResult(
                status=ConnectionStatus.QUOTA_EXHAUSTED,
                detail=ProbeDetail(
                    provider_status=429,
                    provider_code=code or error_type,
                    provider_message=message,
                    remediation=(
                        "The OpenAI key is accepted but its account is out of quota. Add "
                        "credit or raise the usage limit at platform.openai.com → Billing, "
                        "then traffic will flow without reconnecting the key."
                    ),
                ),
            )
        return rate_limited("OpenAI", response)
    if response.status_code >= 500:
        return server_error("OpenAI", response)
    # Any other rejection (403 project restrictions and the like) still means
    # this key cannot serve; surface the provider's own words.
    return ProbeResult(
        status=ConnectionStatus.INVALID,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_code=code,
            provider_message=message,
            remediation=(
                f"OpenAI refused the key ending {masked(credential)} with HTTP "
                f"{response.status_code}. Check the key's project restrictions and "
                "permissions at platform.openai.com → API keys."
            ),
        ),
    )


def probe_spend_key(
    credential: str, *, transport: httpx.BaseTransport | None = None
) -> ProbeResult:
    """Verify one OpenAI ADMIN key against the costs endpoint it will read.

    UNTESTED against a live admin key (ours is dead); written from the
    organization-costs API docs. The prefix rule is checked first so an
    inference key pasted in the admin slot is named as such.
    """
    if not credential.startswith(ADMIN_KEY_PREFIX):
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code="inference_key_in_admin_slot",
                remediation=(
                    f"The key ending {masked(credential)} is an OpenAI inference/project "
                    "API key (sk-…), but the admin slot needs an ADMIN key (sk-admin-…) "
                    "with the api.usage.read scope — the two key types are disjoint. "
                    "Create one at platform.openai.com → Settings → Organization → Admin "
                    "keys and paste it here. The project key belongs in the main "
                    "API-key slot."
                ),
            ),
        )
    try:
        with probe_client(transport) as client:
            response = client.get(
                _COSTS_URL,
                params={"start_time": int(time.time()) - 86_400, "limit": 1},
                headers={"Authorization": f"Bearer {credential}"},
            )
    except httpx.HTTPError as error:
        return unreachable("OpenAI", error)

    if response.is_success:
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                remediation=("The OpenAI admin key works: the organization's costs are readable."),
            ),
        )
    if response.status_code == 429:
        return rate_limited("OpenAI", response)
    if response.status_code >= 500:
        return server_error("OpenAI", response)
    return ProbeResult(
        status=ConnectionStatus.INVALID,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_code=response_error_field(response, "code"),
            provider_message=response_message(response),
            remediation=(
                f"OpenAI rejected the admin key ending {masked(credential)}. Paste a "
                "current admin key (sk-admin-…) with the api.usage.read scope from "
                "platform.openai.com → Settings → Organization → Admin keys and save "
                "again."
            ),
        ),
    )


def spend(
    admin_credential: str | None, *, transport: httpx.BaseTransport | None = None
) -> SpendReport:
    """Read one OpenAI organization's month-to-date cost.

    UNTESTED against live data (no working admin key on this machine);
    written from the organization-costs API docs: daily buckets whose
    ``results[].amount.value`` is a number of dollars. OpenAI has no balance
    API, so remaining credit is never reported.
    """
    if admin_credential is None:
        return SpendReport(
            kind=SpendReportKind.NOT_REPORTABLE,
            message=(
                "Connect an OpenAI admin key (sk-admin-…, scope api.usage.read) to "
                "see this account's month-to-date spend — project keys cannot read "
                "billing. OpenAI exposes no credits balance either way."
            ),
        )
    if not admin_credential.startswith(ADMIN_KEY_PREFIX):
        return SpendReport(
            kind=SpendReportKind.READ_FAILED,
            message=(
                "The stored OpenAI spend credential is a project/inference key "
                "(sk-…), not an admin key (sk-admin-…) — the two key types are "
                "disjoint and project keys cannot read billing. Save an admin key "
                "in the admin-key slot."
            ),
        )

    try:
        with probe_client(transport) as client:
            outcome = spend_contract.paged_buckets(
                client,
                _COSTS_URL,
                params={"start_time": int(month_to_date_start().timestamp()), "limit": 31},
                headers={"Authorization": f"Bearer {admin_credential}"},
                provider_label="OpenAI",
                page_bound=_MAX_COSTS_PAGES,
            )
        if isinstance(outcome, SpendReport):
            return outcome
        buckets = len(outcome)
        total = _amount_total(outcome)
    except httpx.HTTPError as error:
        return spend_contract.unreachable("OpenAI", error)
    except (TypeError, ValueError) as error:
        return spend_contract.read_failed("OpenAI", message=f"unreadable payload: {error}")

    return SpendReport(
        kind=SpendReportKind.REPORTED,
        source=SnapshotSource.PROVIDER_API,
        spend_usd=total,
        detail={"daily_buckets": buckets},
        message=(
            "OpenAI reports month-to-date cost through the admin key. It exposes "
            "no credits balance; use the self-reported gauge for remaining credit."
        ),
    )


def _amount_total(buckets: list[JsonObject]) -> float:
    """Sum every bucket result's ``amount.value`` dollars."""
    total = 0.0
    for bucket in buckets:
        results = bucket.get("results")
        if not isinstance(results, list):
            continue
        for result in results:
            entry = json_object(result)
            amount = json_object(entry.get("amount")) if entry is not None else None
            if amount is not None:
                total += float(str(amount.get("value", 0) or 0))
    return total
