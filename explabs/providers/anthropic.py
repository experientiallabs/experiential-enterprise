# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Anthropic key verification: ``GET /v1/models?limit=1`` with ``x-api-key``.

Live-tested (2026-08-19): admin keys (``sk-ant-admin01-…``) and inference keys
are disjoint — an admin key gets 401 on this endpoint even though it is a real,
working Anthropic credential. The prefix is checked first so the verdict names
which kind was pasted instead of parroting "authentication_error".
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from enum import StrEnum

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

_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1"
_COST_REPORT_URL = "https://api.anthropic.com/v1/organizations/cost_report"
_VERSION_HEADER = "2023-06-01"

# The admin-key namespace; these manage the org (and read spend) but cannot
# do inference at all.
ADMIN_KEY_PREFIX = "sk-ant-admin"


class CostReportUnit(StrEnum):
    """The unit ``cost_report`` amounts are denominated in."""

    CENTS = "cents"
    DOLLARS = "dollars"


# ⚠ UNIT AMBIGUITY — the one place the unit is decided. A live 2026-08-19
# reading returned "amount": "293935.649715" for a single day: as dollars that
# is absurd for this org, and prior internal experience says the unit is
# CENTS, so cents is the default. Pending: the product owner verifies one day's amount
# against the Anthropic console before this number renders as dollars; flip
# this constant if the console disagrees.
COST_REPORT_UNIT = CostReportUnit.CENTS

# cost_report pages by bucket (1 day each); a month is at most 31 buckets, so
# two pages is already generous. The bound keeps a provider bug from looping.
_MAX_COST_REPORT_PAGES = 4


def probe(  # noqa: PLR0911 - one verdict ladder; each branch is a distinct verdict
    credential: str, *, transport: httpx.BaseTransport | None = None
) -> ProbeResult:
    """Verify one Anthropic inference key against the models listing."""
    if credential.startswith(ADMIN_KEY_PREFIX):
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code="admin_key_in_inference_slot",
                remediation=(
                    f"The key ending {masked(credential)} is an Anthropic ADMIN key "
                    "(sk-ant-admin…). Admin keys manage the organization and read spend "
                    "but cannot do inference — the two key types are disjoint. Paste an "
                    "inference API key (sk-ant-api…) from console.anthropic.com → API keys "
                    "here; the admin key belongs in the optional admin-key slot."
                ),
            ),
        )
    try:
        with probe_client(transport) as client:
            response = client.get(
                _MODELS_URL,
                headers={"x-api-key": credential, "anthropic-version": _VERSION_HEADER},
            )
    except httpx.HTTPError as error:
        return unreachable("Anthropic", error)

    if response.is_success:
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                remediation="The Anthropic key works: the account's model list is readable.",
            ),
        )

    error_type = response_error_field(response, "type")
    message = response_message(response)
    if response.status_code == 401:
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=401,
                provider_code=error_type,
                provider_message=message,
                remediation=(
                    f"Anthropic rejected the key ending {masked(credential)} "
                    "(authentication_error). Paste a current inference API key "
                    "(sk-ant-api…) from console.anthropic.com → API keys and save again."
                ),
            ),
        )
    if response.status_code == 429:
        return rate_limited("Anthropic", response)
    if response.status_code >= 500:
        return server_error("Anthropic", response)
    return ProbeResult(
        status=ConnectionStatus.INVALID,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_code=error_type,
            provider_message=message,
            remediation=(
                f"Anthropic refused the key ending {masked(credential)} with HTTP "
                f"{response.status_code}. Check the key's state at console.anthropic.com "
                "→ API keys."
            ),
        ),
    )


def probe_spend_key(
    credential: str, *, transport: httpx.BaseTransport | None = None
) -> ProbeResult:
    """Verify one Anthropic ADMIN key against the cost report it will read.

    The admin slot takes admin keys only: an inference key pasted here is
    named as such (the two key types are disjoint; live-tested 2026-08-19).
    ``starting_at`` is REQUIRED — without it the endpoint answers 400
    "starting_at: Field required" even for a working admin key (live-tested
    2026-08-19 against the local stack), so the probe asks for one recent
    bucket.
    """
    if not credential.startswith(ADMIN_KEY_PREFIX):
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code="inference_key_in_admin_slot",
                remediation=(
                    f"The key ending {masked(credential)} is an Anthropic inference "
                    "API key (sk-ant-api…), but the admin slot needs an ADMIN key "
                    "(sk-ant-admin…) — the two key types are disjoint. Inference keys "
                    "cannot read spend; create an admin key at console.anthropic.com "
                    "→ Settings → Admin keys and paste it here. The inference key "
                    "belongs in the main API-key slot."
                ),
            ),
        )
    try:
        with probe_client(transport) as client:
            # Must sit on a UTC day boundary: a mid-day starting_at rounds up
            # into the (defaulted) ending and answers 400 "Invalid date range"
            # (live-tested 2026-08-19).
            yesterday = datetime.now(tz=UTC).replace(
                hour=0, minute=0, second=0, microsecond=0
            ) - timedelta(days=1)
            starting_at = yesterday.isoformat().replace("+00:00", "Z")
            response = client.get(
                _COST_REPORT_URL,
                params={"starting_at": starting_at, "limit": 1},
                headers={"x-api-key": credential, "anthropic-version": _VERSION_HEADER},
            )
    except httpx.HTTPError as error:
        return unreachable("Anthropic", error)

    if response.is_success:
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                remediation=(
                    "The Anthropic admin key works: the organization's cost report is readable."
                ),
            ),
        )
    if response.status_code == 429:
        return rate_limited("Anthropic", response)
    if response.status_code >= 500:
        return server_error("Anthropic", response)
    return ProbeResult(
        status=ConnectionStatus.INVALID,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_code=response_error_field(response, "type"),
            provider_message=response_message(response),
            remediation=(
                f"Anthropic rejected the admin key ending {masked(credential)}. "
                "Paste a current admin key (sk-ant-admin…) from console.anthropic.com "
                "→ Settings → Admin keys and save again."
            ),
        ),
    )


def spend(
    admin_credential: str | None, *, transport: httpx.BaseTransport | None = None
) -> SpendReport:
    """Read one Anthropic organization's month-to-date cost.

    Live-tested 2026-08-19: ``GET /v1/organizations/cost_report`` (admin key
    only) returns daily buckets whose amounts are decimal STRINGS — summed
    here and converted per :data:`COST_REPORT_UNIT`. Anthropic has no
    credits-balance endpoint at all, so remaining credit is never reported.
    """
    if admin_credential is None:
        return SpendReport(
            kind=SpendReportKind.NOT_REPORTABLE,
            message=(
                "Connect an Anthropic admin key (sk-ant-admin…) to see this "
                "account's month-to-date spend — inference keys cannot read "
                "billing. Anthropic exposes no credits balance either way."
            ),
        )
    if not admin_credential.startswith(ADMIN_KEY_PREFIX):
        return SpendReport(
            kind=SpendReportKind.READ_FAILED,
            message=(
                "The stored Anthropic spend credential is an inference key "
                "(sk-ant-api…), not an admin key (sk-ant-admin…) — the two key "
                "types are disjoint and inference keys cannot read billing. "
                "Save an admin key in the admin-key slot."
            ),
        )

    try:
        with probe_client(transport) as client:
            outcome = spend_contract.paged_buckets(
                client,
                _COST_REPORT_URL,
                params={
                    "starting_at": month_to_date_start().isoformat().replace("+00:00", "Z"),
                    "limit": 31,
                },
                headers={"x-api-key": admin_credential, "anthropic-version": _VERSION_HEADER},
                provider_label="Anthropic",
                page_bound=_MAX_COST_REPORT_PAGES,
            )
        if isinstance(outcome, SpendReport):
            return outcome
        buckets = len(outcome)
        raw_total = _amount_total(outcome)
    except httpx.HTTPError as error:
        return spend_contract.unreachable("Anthropic", error)
    except (TypeError, ValueError) as error:
        return spend_contract.read_failed("Anthropic", message=f"unreadable payload: {error}")

    match COST_REPORT_UNIT:
        case CostReportUnit.CENTS:
            spend_usd = raw_total / 100
        case CostReportUnit.DOLLARS:
            spend_usd = raw_total
    return SpendReport(
        kind=SpendReportKind.REPORTED,
        source=SnapshotSource.PROVIDER_API,
        spend_usd=spend_usd,
        detail={
            "raw_amount_total": raw_total,
            "amount_unit": COST_REPORT_UNIT.value,
            "daily_buckets": buckets,
        },
        message=(
            "Anthropic reports month-to-date cost through the admin key. "
            "It exposes no credits balance; use the self-reported gauge for "
            "remaining credit."
        ),
    )


def _amount_total(buckets: list[JsonObject]) -> float:
    """Sum every bucket result's decimal-string amount, in the raw unit."""
    total = 0.0
    for bucket in buckets:
        results = bucket.get("results")
        if not isinstance(results, list):
            continue
        for result in results:
            entry = json_object(result)
            if entry is not None:
                total += float(str(entry.get("amount", 0) or 0))
    return total
