# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The spend/credit read contract and the per-provider dispatch.

A spend read answers "what can this provider account report right now?" —
month-to-date spend, credits remaining, usage limit — and is honest when the
answer is "nothing": every provider yields exactly one of three verdicts,
``reported`` (numbers ride a snapshot), ``not_reportable`` (the provider
exposes no billing to this credential kind; the message says so plainly),
or ``read_failed`` (the provider should report but this read did not work).

These reads are management-plane only: they NEVER route through the
gateway/serving path, and their credentials are released only into the
adapter call.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

import httpx
from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject
from explabs.db.stores.provider_connection_store import (
    ConnectableProvider,
    ProviderConnectionRecord,
)
from explabs.db.stores.provider_snapshot_store import SnapshotSource


class SpendReportKind(StrEnum):
    """The three honest outcomes of one spend read."""

    REPORTED = "reported"
    # The provider exposes no billing to this credential kind — a fact about
    # the provider, not a failure. The self-reported gauge is the only number.
    NOT_REPORTABLE = "not_reportable"
    # The provider should report but this read failed (bad admin key, IAM
    # policy gap, outage). The message names the failure and the fix.
    READ_FAILED = "read_failed"


class SpendReport(BaseModel):
    """One provider account's reading, or the honest reason there is none."""

    model_config = ConfigDict(frozen=True)

    kind: SpendReportKind
    # Set exactly when kind is REPORTED: which lane produced the numbers.
    source: SnapshotSource | None = None
    spend_usd: float | None = None
    credits_remaining_usd: float | None = None
    usage_limit_usd: float | None = None
    # Non-secret extras (per-model breakdowns, raw figures, provider notes).
    detail: JsonObject | None = None
    # Always present: the customer-facing sentence for this verdict.
    message: str


# Server-side staleness floors, per provider: a refresh inside the floor
# returns the latest stored snapshot instead of querying the provider, so
# "refresh quite often" stays cheap-safe. Bedrock's floor is hours because
# AWS Cost Explorer bills $0.01 PER QUERY and its data lags ~24 h anyway.
# Gemini and Azure are never queried (nothing is reportable), so their floor
# is zero — there is no provider call to protect.
SPEND_REFRESH_FLOOR_SECONDS: dict[ConnectableProvider, int] = {
    ConnectableProvider.OPENAI: 5 * 60,
    ConnectableProvider.ANTHROPIC: 5 * 60,
    ConnectableProvider.OPENROUTER: 5 * 60,
    ConnectableProvider.FIREWORKS: 5 * 60,
    ConnectableProvider.MODAL: 5 * 60,
    ConnectableProvider.BEDROCK: 3 * 60 * 60,
    ConnectableProvider.GEMINI: 0,
    ConnectableProvider.AZURE_OPENAI: 0,
}


def month_to_date_start(now: datetime | None = None) -> datetime:
    """The UTC start of the current calendar month — every adapter's window."""
    moment = now if now is not None else datetime.now(tz=UTC)
    return moment.astimezone(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def read_spend(  # noqa: PLR0911 - one dispatch table; each branch is a provider
    record: ProviderConnectionRecord,
    *,
    credential: str | None,
    spend_credential: str | None,
    transport: httpx.BaseTransport | None = None,
) -> SpendReport:
    """Read what the stored connection's provider account can report.

    Args:
        record: The connection row (provider + non-secret config).
        credential: The released main Vault secret, for providers whose own
            key can read billing (openrouter, bedrock, fireworks, modal).
        spend_credential: The released admin-key secret, for providers that
            keep billing behind a separate admin key (anthropic, openai);
            ``None`` yields the honest connect-an-admin-key state.
        transport: Optional httpx transport override for tests; the SDK-backed
            providers (bedrock, modal) expose their own seams instead.

    Returns:
        The provider account's reading, or the honest reason there is none.
    """
    from explabs.providers import (
        anthropic,
        azure_openai,
        bedrock,
        fireworks,
        gemini,
        modal,
        openai,
        openrouter,
    )

    match record.provider:
        case ConnectableProvider.OPENROUTER:
            return openrouter.spend(required(credential), transport=transport)
        case ConnectableProvider.ANTHROPIC:
            return anthropic.spend(spend_credential, transport=transport)
        case ConnectableProvider.OPENAI:
            return openai.spend(spend_credential, transport=transport)
        case ConnectableProvider.GEMINI:
            return gemini.spend()
        case ConnectableProvider.AZURE_OPENAI:
            return azure_openai.spend()
        case ConnectableProvider.BEDROCK:
            return bedrock.spend(required(credential), record.bedrock_config())
        case ConnectableProvider.FIREWORKS:
            return fireworks.spend(
                required(credential), record.fireworks_config(), transport=transport
            )
        case ConnectableProvider.MODAL:
            return modal.spend(required(credential))


def required(credential: str | None) -> str:
    """The main credential, which the dispatched providers always have.

    Raises:
        ValueError: If the caller dispatched a main-credential provider
            without releasing its secret — a caller bug, not a provider state.
    """
    if credential is None:
        msg = "a released main credential is required for this provider's spend read"
        raise ValueError(msg)
    return credential


def paged_buckets(
    client: httpx.Client,
    url: str,
    *,
    params: dict[str, str | int],
    headers: dict[str, str],
    provider_label: str,
    page_bound: int,
) -> list[JsonObject] | SpendReport:
    """Collect a paged billing endpoint's ``data`` buckets, or the failure.

    Anthropic's cost_report and OpenAI's organization costs page the same
    way: ``data`` buckets plus ``has_more``/``next_page``. The bound keeps a
    provider bug from looping; a month of daily buckets fits one page.
    """
    from explabs.providers.accounts import response_message

    buckets: list[JsonObject] = []
    page: str | None = None
    for _ in range(page_bound):
        page_params: dict[str, str | int] = dict(params)
        if page is not None:
            page_params["page"] = page
        response = client.get(url, params=page_params, headers=headers)
        if not response.is_success:
            return read_failed(
                provider_label,
                status=response.status_code,
                message=response_message(response),
            )
        payload = response.json()
        buckets.extend(payload.get("data", []))
        page = payload.get("next_page")
        if not payload.get("has_more") or page is None:
            break
    return buckets


def read_failed(
    provider_label: str, *, status: int | None = None, message: str | None = None
) -> SpendReport:
    """A generic failed provider billing read, with the provider's own words."""
    said = f" It said: {message}" if message else ""
    suffix = f" (HTTP {status})" if status is not None else ""
    return SpendReport(
        kind=SpendReportKind.READ_FAILED,
        detail={"provider_status": status, "provider_message": message},
        message=(
            f"{provider_label} refused the spend read{suffix}.{said} "
            "The stored numbers are unchanged; try again later."
        ),
    )


def unreachable(provider_label: str, error: httpx.HTTPError) -> SpendReport:
    """The provider could not be reached: our read failed, not their account."""
    return SpendReport(
        kind=SpendReportKind.READ_FAILED,
        detail={"provider_code": type(error).__name__, "provider_message": str(error) or None},
        message=(
            f"{provider_label} could not be reached to read spend "
            f"({type(error).__name__}). The stored numbers are unchanged; "
            "try again later."
        ),
    )
