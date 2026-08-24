# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Fireworks key verification: ``GET /inference/v1/models`` with the bearer key.

The account_id in the connection's config is for billing reads only; the
inference models listing validates the key alone.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import httpx

from explabs.db.stores.provider_connection_store import ConnectionStatus, FireworksConnectionConfig
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers import spend as spend_contract
from explabs.providers.accounts import (
    ProbeDetail,
    ProbeResult,
    json_object,
    masked,
    probe_client,
    rate_limited,
    response_message,
    server_error,
    unreachable,
)
from explabs.providers.discovery import DiscoveredModel, slugify
from explabs.providers.spend import SpendReport, SpendReportKind, month_to_date_start

_MODELS_URL = "https://api.fireworks.ai/inference/v1/models"
_BILLING_SUMMARY_URL = "https://api.fireworks.ai/v1/accounts/{account_id}/billing/summary"
# Control-plane library of the public Fireworks account: the full model list
# (500+, mostly community HF checkpoints), paginated by ``nextPageToken``.
_LIBRARY_URL = "https://api.fireworks.ai/v1/accounts/fireworks/models"
_LIBRARY_PAGE_SIZE = 200
_LIBRARY_MAX_PAGES = 200  # generous ceiling; the library is ~500 today

# The provider key the sync stamps on Fireworks catalog rows, and the slug
# namespace that keeps auto-discovered rows from colliding with curated slugs.
PROVIDER = "fireworks"

# ``kind`` values the chat gateway cannot serve: embeddings, image (Flumina),
# and adapters/addons. They are still listed (1:1 mirror) but marked
# non-servable, so the storefront shows them while no served route is built.
# Any unknown kind defaults to chat-servable (list it) rather than crashing.
_NON_CHAT_KINDS = frozenset(
    {
        "EMBEDDING_MODEL",
        "FLUMINA_BASE_MODEL",
        "FLUMINA_ADDON",
        "DRAFT_ADDON",
        "HF_TEFT_ADDON",
        "HF_PEFT_ADDON",
        "HF_LORA_ADDON",
    }
)

# Fireworks serverless executes every served model over streaming SSE, so every
# servable discovered row carries the capability the gateway requires (a row
# without supports_streaming is unservable). Tool support is per-model.
_STREAMING = "supports_streaming"


def probe(  # noqa: PLR0911 - one verdict ladder; each branch is a distinct verdict
    credential: str, *, transport: httpx.BaseTransport | None = None
) -> ProbeResult:
    """Verify one Fireworks API key against the models listing."""
    try:
        with probe_client(transport) as client:
            response = client.get(_MODELS_URL, headers={"Authorization": f"Bearer {credential}"})
    except httpx.HTTPError as error:
        return unreachable("Fireworks", error)

    if response.is_success:
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                remediation="The Fireworks key works: the model list is readable.",
            ),
        )

    message = response_message(response)
    if response.status_code in (401, 403):
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                provider_message=message,
                remediation=(
                    f"Fireworks rejected the key ending {masked(credential)}. Paste a "
                    "current API key (fw_…) from fireworks.ai → API keys and save again."
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
                    "The Fireworks key is accepted but the account is out of credit. Top "
                    "up at fireworks.ai → Billing; traffic then flows without "
                    "reconnecting the key."
                ),
            ),
        )
    if response.status_code == 429:
        return rate_limited("Fireworks", response)
    if response.status_code >= 500:
        return server_error("Fireworks", response)
    return ProbeResult(
        status=ConnectionStatus.INVALID,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_message=message,
            remediation=(
                f"Fireworks refused the key ending {masked(credential)} with HTTP "
                f"{response.status_code}. Check the key at fireworks.ai → API keys."
            ),
        ),
    )


def list_models(
    credential: str, *, transport: httpx.BaseTransport | None = None
) -> tuple[DiscoveredModel, ...]:
    """Discover the ENTIRE Fireworks model library (1:1 mirror).

    Reads the control-plane library ``GET /v1/accounts/fireworks/models``
    (paginated by ``nextPageToken``): every model the account exposes, mostly
    community HF checkpoints, plus embeddings, image (Flumina), and adapters.
    Funding lane by whether the house key can already serve it:

    - ``supportsServerless`` chat models are house-deployable, so they are
      ``host_managed`` (priced-or-hidden — Fireworks has no price API, so they
      stay hidden until a hand-curated price lands).
    - Every other chat model is ``customer_managed`` (BYOK-by-default): the
      caller funds it with their own Fireworks key, routed per-org by the
      gateway (public customer_managed), with a fail-closed error for callers
      who bring no key.
    - Non-chat kinds (embeddings/image/adapters) are listed for completeness but
      marked non-servable — no chat route is built for them.

    Unknown ``kind`` values default to chat-servable (list, don't crash).

    Args:
        credential: A Fireworks API key (``fw_…``).
        transport: Test seam for the HTTP client.

    Returns:
        One price-less record per library model, sorted by slug.

    Raises:
        httpx.HTTPError: The listing could not be read.
    """
    discovered: list[DiscoveredModel] = []
    with probe_client(transport) as client:
        page_token = ""
        for _ in range(_LIBRARY_MAX_PAGES):
            params = {"pageSize": str(_LIBRARY_PAGE_SIZE)}
            if page_token:
                params["pageToken"] = page_token
            response = client.get(
                _LIBRARY_URL,
                params=params,
                headers={"Authorization": f"Bearer {credential}"},
            )
            response.raise_for_status()
            body = json_object(response.json())
            if body is None:
                break
            models = body.get("models")
            for row in models if isinstance(models, list) else []:
                record = json_object(row)
                model = _library_model(record) if record is not None else None
                if model is not None:
                    discovered.append(model)
            next_token = body.get("nextPageToken")
            page_token = next_token if isinstance(next_token, str) else ""
            if not page_token:
                break
    return tuple(sorted(discovered, key=lambda model: model.slug))


def _library_model(record: dict[str, object]) -> DiscoveredModel | None:
    """Map one control-plane library row to a catalog record, or ``None``."""
    name = str(record.get("name", ""))
    identifier = name.removeprefix("accounts/fireworks/")
    tail = name.rsplit("/", 1)[-1]
    if not tail:
        return None
    kind = str(record.get("kind", ""))
    servable = kind not in _NON_CHAT_KINDS
    serverless = bool(record.get("supportsServerless"))
    context = record.get("contextLength") or record.get("trainingContextLength")
    modalities = ("text", "image") if record.get("supportsImageInput") else ("text",)
    # House-deployable serverless chat is the platform-funded lane; everything
    # else the caller funds with their own key.
    billing = "host_managed" if (serverless and servable) else "customer_managed"
    return DiscoveredModel(
        slug=slugify(PROVIDER, identifier),
        display_name=f"{_prettify(tail)} (Fireworks)",
        provider=PROVIDER,
        provider_model_id=name,
        context_window=int(context) if isinstance(context, int) and context > 0 else None,
        input_modalities=modalities,
        supported_params={"tools": bool(record.get("supportsTools"))},
        capabilities={_STREAMING: True} if servable else {},
        price=None,
        billing_source=billing,
        servable=servable,
    )


def _prettify(tail: str) -> str:
    """A readable display name from a Fireworks wire tail (e.g. ``kimi-k2p6``)."""
    return " ".join(word.capitalize() for word in re.split(r"[-_]", tail) if word)


def spend(
    credential: str,
    config: FireworksConnectionConfig,
    *,
    transport: httpx.BaseTransport | None = None,
) -> SpendReport:
    """Read one Fireworks account's month-to-date rated cost.

    Live-tested 2026-08-19: ``GET /v1/accounts/{account_id}/billing/summary``
    (the account id rides the connection's config; it is not discoverable
    from the key). Times must be full RFC3339 — a bare date is refused.
    Costs arrive as protobuf Money objects whose int64 ``units`` is a JSON
    STRING beside int ``nanos``; token quantities can arrive as string int64
    too. Fireworks has no balance endpoint, so remaining credit is never
    reported.
    """
    start = month_to_date_start()
    end = datetime.now(tz=UTC) + timedelta(days=1)
    try:
        with probe_client(transport) as client:
            response = client.get(
                _BILLING_SUMMARY_URL.format(account_id=config.account_id),
                params={
                    "startTime": _rfc3339(start),
                    "endTime": _rfc3339(end.replace(hour=0, minute=0, second=0, microsecond=0)),
                },
                headers={"Authorization": f"Bearer {credential}"},
            )
    except httpx.HTTPError as error:
        return spend_contract.unreachable("Fireworks", error)
    if response.status_code in (403, 404):
        return SpendReport(
            kind=SpendReportKind.READ_FAILED,
            detail={
                "provider_status": response.status_code,
                "provider_message": response_message(response),
            },
            message=(
                f"Fireworks refused the billing read for account "
                f"{config.account_id!r} (HTTP {response.status_code}). Check that "
                "the account id matches the key's account (the slug on "
                "fireworks.ai) and save the connection again."
            ),
        )
    if not response.is_success:
        return spend_contract.read_failed(
            "Fireworks", status=response.status_code, message=response_message(response)
        )

    try:
        payload = response.json()
        line_items = payload.get("lineItems", []) or []
        total = 0.0
        by_category: dict[str, float] = {}
        for item in line_items:
            cost = _money_usd(item.get("totalCost"))
            total += cost
            category = str(item.get("category", ""))
            by_category[category] = by_category.get(category, 0.0) + cost
    except (TypeError, ValueError) as error:
        return spend_contract.read_failed("Fireworks", message=f"unreadable payload: {error}")
    return SpendReport(
        kind=SpendReportKind.REPORTED,
        source=SnapshotSource.PROVIDER_API,
        spend_usd=total,
        detail={
            "by_category_usd": {name: round(value, 6) for name, value in by_category.items()},
            "line_items": len(line_items),
        },
        message=(
            "Fireworks reports month-to-date rated cost for this account. It "
            "exposes no credits balance; use the self-reported gauge for "
            "remaining credit."
        ),
    )


def _rfc3339(moment: datetime) -> str:
    """Fireworks' required timestamp spelling (Z suffix, no offset form)."""
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _money_usd(value: object) -> float:
    """A protobuf Money object as float dollars.

    ``units`` is an int64 that arrives as a JSON STRING; ``nanos`` is an int.
    Anything unreadable raises so the caller reports the payload honestly.
    """
    if value is None:
        return 0.0
    money = json_object(value)
    if money is None:
        msg = f"expected a Money object, got {type(value).__name__}"
        raise TypeError(msg)
    units = money.get("units", 0)
    nanos = money.get("nanos", 0)
    return float(int(str(units or 0))) + float(int(str(nanos or 0))) / 1_000_000_000
