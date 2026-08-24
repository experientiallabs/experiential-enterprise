# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Bedrock credential verification: ``ListFoundationModels`` via boto3.

The stored credential pair is the org's own IAM access key id (non-secret
config) plus secret access key (Vault). IAM rejections map to ``invalid``;
an unreachable or malformed region is its own remediation because the fix is
the region field, not the key.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import boto3
import httpx
from botocore.exceptions import BotoCoreError, ClientError, EndpointConnectionError

from explabs.db.stores.provider_connection_store import BedrockConnectionConfig, ConnectionStatus
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers.accounts import PROBE_TIMEOUT_SECONDS, ProbeDetail, ProbeResult
from explabs.providers.discovery import (
    DiscoveredModel,
    DiscoveredPrice,
    normalize_modalities,
    slugify,
    to_micro_usd_per_million,
)
from explabs.providers.spend import SpendReport, SpendReportKind, month_to_date_start

# The provider key stamped on Bedrock catalog rows and the slug namespace that
# keeps auto-discovered rows from colliding with curated slugs.
PROVIDER = "bedrock"

# The regions the platform serves Bedrock in; a model available in either is
# reachable, and the union (deduped by model id) is the catalog set.
SERVED_REGIONS: tuple[str, ...] = ("us-east-1", "us-west-2")

# Public AWS Price List Bulk API (no credentials): the house IAM user lacks
# pricing:GetProducts, and the bulk offer files carry the same figures.
_PRICE_LIST_BASE = "https://pricing.us-east-1.amazonaws.com"
_PRICE_LIST_REGION_INDEX = "/offers/v1.0/aws/AmazonBedrock/current/region_index.json"


class _BedrockClient(Protocol):
    """The one Bedrock control-plane call the probe needs."""

    def list_foundation_models(self) -> object:
        """AWS ListFoundationModels.

        The probe reads liveness and authorization from whether this call
        raises, never from the body, so the return is intentionally left
        opaque: boto3 ships no precise response type, and validating a JSON
        shape we never consume would be dead surface that could misreport a
        valid key on benign response drift.
        """
        ...


# The credential rejections IAM answers with; all mean the key pair itself is
# the problem. AccessDenied means real credentials that lack
# bedrock:ListFoundationModels — named separately in the remediation.
_INVALID_CREDENTIAL_CODES = frozenset(
    {"UnrecognizedClientException", "InvalidSignatureException", "SignatureDoesNotMatch"}
)
_THROTTLING_CODES = frozenset({"ThrottlingException", "TooManyRequestsException"})


def _default_client(config: BedrockConnectionConfig, secret_access_key: str) -> _BedrockClient:
    """A tenant-scoped Bedrock control-plane client (never the ambient chain)."""
    from botocore.config import Config

    return boto3.client(
        "bedrock",
        region_name=config.region,
        aws_access_key_id=config.access_key_id,
        aws_secret_access_key=secret_access_key,
        config=Config(
            connect_timeout=PROBE_TIMEOUT_SECONDS,
            read_timeout=PROBE_TIMEOUT_SECONDS,
            retries={"max_attempts": 1},
        ),
    )


def probe(
    secret_access_key: str,
    config: BedrockConnectionConfig,
    *,
    client_factory: Callable[[BedrockConnectionConfig, str], _BedrockClient] = _default_client,
) -> ProbeResult:
    """Verify one IAM key pair by listing Bedrock foundation models."""
    try:
        client = client_factory(config, secret_access_key)
        client.list_foundation_models()
    except EndpointConnectionError as error:
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code=type(error).__name__,
                provider_message=str(error),
                remediation=(
                    f"AWS has no reachable Bedrock endpoint for region {config.region!r}. "
                    "Check the region spelling and that Bedrock is available there "
                    "(e.g. us-east-1, us-west-2), then save again."
                ),
            ),
        )
    except ClientError as error:
        return _client_error_result(error, config)
    except (BotoCoreError, ValueError) as error:
        # Client construction failures (malformed region and the like) are
        # config problems the user can fix, not AWS outages.
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code=type(error).__name__,
                provider_message=str(error),
                remediation=(
                    "The Bedrock connection could not be built from the stored region and "
                    "key pair. Check the region, access key id, and secret access key, "
                    "then save again."
                ),
            ),
        )
    return ProbeResult(
        status=ConnectionStatus.VALID,
        detail=ProbeDetail(
            remediation=(
                f"The AWS key pair works: Bedrock foundation models are listable in "
                f"{config.region}."
            ),
        ),
    )


def _client_error_result(error: ClientError, config: BedrockConnectionConfig) -> ProbeResult:
    """Map one AWS ClientError onto the canonical status vocabulary."""
    aws = error.response.get("Error", {})
    code = str(aws.get("Code", "")) or type(error).__name__
    message = str(aws.get("Message", "")) or str(error)
    http_status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    status_code = int(http_status) if isinstance(http_status, int) else None
    if code in _INVALID_CREDENTIAL_CODES:
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=status_code,
                provider_code=code,
                provider_message=message,
                remediation=(
                    f"AWS rejected the key pair for access key id {config.access_key_id}: "
                    "the id and secret do not form live credentials. Re-copy both halves "
                    "from IAM → Security credentials (a rotated key invalidates the old "
                    "secret) and save again."
                ),
            ),
        )
    if code == "AccessDeniedException":
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=status_code,
                provider_code=code,
                provider_message=message,
                remediation=(
                    f"The AWS credentials for {config.access_key_id} are real but IAM "
                    "denies Bedrock access. Attach a policy allowing "
                    "bedrock:ListFoundationModels and bedrock:InvokeModel in "
                    f"{config.region} to the key's user or role, then save again."
                ),
            ),
        )
    if code in _THROTTLING_CODES:
        return ProbeResult(
            status=ConnectionStatus.RATE_LIMITED,
            detail=ProbeDetail(
                provider_status=status_code,
                provider_code=code,
                provider_message=message,
                remediation=(
                    "AWS throttled the account while we verified the credentials. The key "
                    "pair is accepted; wait for the throttle to clear and send traffic "
                    "normally."
                ),
            ),
        )
    return ProbeResult(
        status=ConnectionStatus.PROVIDER_ERROR,
        detail=ProbeDetail(
            provider_status=status_code,
            provider_code=code,
            provider_message=message,
            remediation=(
                f"AWS answered {code} while we verified the credentials — a provider-side "
                "failure, not your key pair. The connection is saved; real traffic will "
                "verify it, or rotate the key to re-run the check."
            ),
        ),
    )


# --- Model discovery ------------------------------------------------------


class _BedrockCatalogClient(Protocol):
    """The two control-plane calls model discovery needs."""

    def list_foundation_models(self) -> Mapping[str, Any]:
        """AWS ListFoundationModels."""
        ...

    def list_inference_profiles(self, **kwargs: Any) -> Mapping[str, Any]:
        """AWS ListInferenceProfiles."""
        ...


def _default_catalog_client(
    region: str, access_key_id: str, secret_access_key: str
) -> _BedrockCatalogClient:
    """A tenant-scoped Bedrock control-plane client for one region."""
    from botocore.config import Config

    return boto3.client(
        "bedrock",
        region_name=region,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        config=Config(retries={"max_attempts": 2}),
    )


def list_models(
    access_key_id: str,
    secret_access_key: str,
    *,
    regions: Iterable[str] = SERVED_REGIONS,
    price_book: BedrockPriceBook | None = None,
    client_factory: Callable[[str, str, str], _BedrockCatalogClient] = _default_catalog_client,
) -> tuple[DiscoveredModel, ...]:
    """Discover the ENTIRE Bedrock foundation-model catalog (1:1 mirror).

    Every ACTIVE foundation model is returned — text, image, and embedding —
    for a complete catalog mirror. The union across ``regions`` is deduped by
    model id (the first region carrying it wins the region tag). Each row is
    marked ``servable`` only when the chat gateway can actually run it (TEXT
    output, streaming, and invocable ON_DEMAND or via an inference profile);
    non-servable rows are listed for completeness but given no chat route. All
    rows are ``host_managed`` — Bedrock BYOK is not yet routable in the shared
    catalog (one runtime factory per catalog; module docstring).

    Pricing is exact-match against ``price_book`` for servable rows; a model the
    AWS Price List does not cover comes back price-less, so the sync leaves it
    hidden rather than guessing a rate that would mischarge.

    Args:
        access_key_id: House AWS access key id (control-plane read only).
        secret_access_key: The matching secret access key.
        regions: Regions to union; defaults to :data:`SERVED_REGIONS`.
        price_book: AWS Price List lookup, or ``None`` to skip pricing.
        client_factory: Test seam for the per-region control-plane client.

    Returns:
        One record per ACTIVE foundation model, sorted by slug.
    """
    profiles: dict[str, str] = {}
    summaries: dict[str, tuple[str, Mapping[str, Any]]] = {}
    for region in regions:
        client = client_factory(region, access_key_id, secret_access_key)
        for profile in _iter_inference_profiles(client):
            profile_id = str(profile.get("inferenceProfileId", ""))
            for member in profile.get("models", []) or []:
                member_id = str(member.get("modelArn", "")).rsplit("/", 1)[-1]
                if member_id and profile_id:
                    profiles.setdefault(member_id, profile_id)
        # ListFoundationModels is not paginated; it returns the full region set.
        for summary in client.list_foundation_models().get("modelSummaries", []) or []:
            model_id = str(summary.get("modelId", ""))
            if model_id and model_id not in summaries:
                summaries[model_id] = (region, summary)
    discovered: list[DiscoveredModel] = []
    for model_id, (region, summary) in summaries.items():
        record = _library_model(model_id, region, summary, profiles, price_book)
        if record is not None:
            discovered.append(record)
    return tuple(sorted(discovered, key=lambda model: model.slug))


def _iter_inference_profiles(client: _BedrockCatalogClient) -> Iterator[Mapping[str, Any]]:
    """Yield every inference profile, following ListInferenceProfiles pagination.

    Reading only the first page would drop profile-only models on later pages
    and let reconciliation wrongly hide their existing rows as removed.
    """
    next_token: str | None = None
    while True:
        page = (
            client.list_inference_profiles(maxResults=1000, nextToken=next_token)
            if next_token
            else client.list_inference_profiles(maxResults=1000)
        )
        yield from page.get("inferenceProfileSummaries", []) or []
        token = page.get("nextToken")
        next_token = str(token) if token else None
        if next_token is None:
            break


def _library_model(
    model_id: str,
    region: str,
    summary: Mapping[str, Any],
    profiles: Mapping[str, str],
    price_book: BedrockPriceBook | None,
) -> DiscoveredModel | None:
    """Map one ACTIVE foundation model to a catalog record (1:1 mirror).

    Every ACTIVE model is listed for completeness — including image and
    embedding rows the chat gateway cannot serve. A row is ``servable`` only
    when it emits TEXT, streams, and is invocable (ON_DEMAND or via an inference
    profile); non-servable rows are listed but never given a chat route. All are
    ``host_managed``: Bedrock BYOK is not yet routable in the shared catalog.
    """
    if (summary.get("modelLifecycle") or {}).get("status") != "ACTIVE":
        return None
    on_demand = "ON_DEMAND" in (summary.get("inferenceTypesSupported") or [])
    profile_id = profiles.get(model_id)
    provider_model_id = model_id if on_demand or profile_id is None else profile_id
    text_output = "TEXT" in (summary.get("outputModalities") or [])
    streaming = bool(summary.get("responseStreamingSupported"))
    servable = text_output and streaming and (on_demand or profile_id is not None)
    name = str(summary.get("modelName") or model_id)
    price = (
        price_book.lookup(model_id, name, cross_region=not on_demand)
        if price_book is not None and servable
        else None
    )
    return DiscoveredModel(
        slug=slugify(PROVIDER, model_id),
        display_name=f"{name} (Bedrock)",
        provider=PROVIDER,
        provider_model_id=provider_model_id,
        region=region,
        input_modalities=normalize_modalities(summary.get("inputModalities")),
        supported_params={},
        capabilities={"supports_streaming": True} if servable else {},
        price=price,
        servable=servable,
    )


# --- AWS Price List (public bulk offer files) -----------------------------

# The two per-token inference dimensions the catalog prices; every other
# dimension (video/image/cache/batch) is ignored so only chat token rates land.
_TOKEN_KIND: Mapping[str, str] = {"Input tokens": "input", "Output tokens": "output"}
_USAGETYPE_ID = re.compile(
    r"^[A-Z0-9]+-(.+?)-(?:input|output)-tokens(?:-cross-region)?(?:-global)?$",
    re.IGNORECASE,
)


def _norm(value: str) -> str:
    """Collapse a model id or display name to a match key (alnum, lowercase)."""
    return re.sub(r"[^a-z0-9]", "", value.lower())


class BedrockPriceBook:
    """Exact-match Bedrock token prices parsed from the AWS Price List.

    Two lanes are kept apart — standard on-demand rates and cross-region
    (inference-profile) rates — because a model served through a profile bills
    at the cross-region rate. A lookup returns a price only when BOTH the input
    and output rate match the same key in the lane the deployment uses; it never
    falls back across lanes or accepts a partial match, so a returned price is
    always the authoritative rate for that exact model and lane.
    """

    def __init__(
        self,
        standard: Mapping[tuple[str, str], float],
        cross_region: Mapping[tuple[str, str], float],
    ) -> None:
        """Bind the collapsed standard and cross-region rate lanes."""
        self._standard = dict(standard)
        self._cross_region = dict(cross_region)

    def lookup(
        self, model_id: str, model_name: str, *, cross_region: bool
    ) -> DiscoveredPrice | None:
        """Return the authoritative price for one model+lane, or ``None``."""
        lane = self._cross_region if cross_region else self._standard
        for key in self._keys(model_id, model_name):
            input_usd = lane.get((key, "input"))
            output_usd = lane.get((key, "output"))
            if input_usd is not None and output_usd is not None:
                return DiscoveredPrice(
                    input_micro_usd_per_million=to_micro_usd_per_million(input_usd),
                    output_micro_usd_per_million=to_micro_usd_per_million(output_usd),
                    pricing_source="aws-price-list",
                )
        return None

    @staticmethod
    def _keys(model_id: str, model_name: str) -> tuple[str, ...]:
        """Candidate match keys for one foundation model, most specific first."""
        base = model_id.split(":", 1)[0]
        return tuple(
            dict.fromkeys(
                key for key in (_norm(model_name), _norm(base), _norm(base.split(".")[-1])) if key
            )
        )


def fetch_price_book(
    *, regions: Iterable[str] = SERVED_REGIONS, transport: httpx.BaseTransport | None = None
) -> BedrockPriceBook:
    """Fetch and index the AWS Price List offer files for the served regions.

    Uses the public bulk offer files (no credentials), because the house IAM
    user lacks ``pricing:GetProducts`` and the bulk files carry the same rates.
    Rates that appear under one match key with two different values are dropped
    as ambiguous (see :func:`_collapse`), so a returned price is never a guess.

    Raises:
        httpx.HTTPError: The region index or an offer file could not be read.
    """
    standard: dict[tuple[str, str], set[float]] = {}
    cross_region: dict[tuple[str, str], set[float]] = {}
    with httpx.Client(timeout=120.0, transport=transport) as client:
        index = client.get(_PRICE_LIST_BASE + _PRICE_LIST_REGION_INDEX)
        index.raise_for_status()
        region_entries = index.json().get("regions", {}) or {}
        for region in regions:
            entry = region_entries.get(region) or {}
            version_url = entry.get("currentVersionUrl")
            if not version_url:
                continue
            offer = client.get(_PRICE_LIST_BASE + version_url)
            offer.raise_for_status()
            _index_offer(offer.json(), standard, cross_region)
    return BedrockPriceBook(_collapse(standard), _collapse(cross_region))


def _collapse(raw: Mapping[tuple[str, str], set[float]]) -> dict[tuple[str, str], float]:
    """Keep only keys whose rows agree on a single rate; drop the ambiguous.

    A normalized model key that two different rates file under (a display-name
    collision, or a tiered/variant rate) is money-unsafe to resolve, so it is
    omitted entirely and the model falls through to hidden-until-priced.
    """
    return {key: next(iter(values)) for key, values in raw.items() if len(values) == 1}


def _index_offer(
    offer: Mapping[str, Any],
    standard: dict[tuple[str, str], set[float]],
    cross_region: dict[tuple[str, str], set[float]],
) -> None:
    """Fold one region's offer file into the standard/cross-region lanes."""
    products = offer.get("products", {}) or {}
    on_demand_terms = (offer.get("terms", {}) or {}).get("OnDemand", {}) or {}
    for sku, product in products.items():
        attributes = product.get("attributes", {}) or {}
        token = _TOKEN_KIND.get(str(attributes.get("inferenceType", "")))
        if token is None:
            continue
        usagetype = str(attributes.get("usagetype", ""))
        usd = _sku_usd_per_1k(on_demand_terms.get(sku))
        if usd is None:
            continue
        lane = cross_region if "cross-region" in usagetype.lower() else standard
        for key in _offer_keys(str(attributes.get("model", "")), usagetype):
            lane.setdefault((key, token), set()).add(usd)


def _offer_keys(model_attribute: str, usagetype: str) -> tuple[str, ...]:
    """Match keys a price row is filed under: its model name and usagetype id."""
    keys = [_norm(model_attribute)] if model_attribute else []
    match = _USAGETYPE_ID.match(usagetype)
    if match:
        keys.append(_norm(match.group(1)))
    return tuple(key for key in dict.fromkeys(keys) if key)


def _as_map(value: object) -> Mapping[Any, Any] | None:
    """Return ``value`` as a JSON object mapping, or ``None`` if it is not one."""
    return value if isinstance(value, Mapping) else None


def _sku_usd_per_1k(term_group: object) -> float | None:
    """The single per-1K-token USD rate for one SKU's OnDemand term."""
    terms = _as_map(term_group)
    if terms is None:
        return None
    for term in terms.values():
        term_map = _as_map(term)
        dimensions = _as_map(term_map.get("priceDimensions")) if term_map else None
        if dimensions is None:
            continue
        for dimension in dimensions.values():
            dimension_map = _as_map(dimension)
            price_per_unit = _as_map(dimension_map.get("pricePerUnit")) if dimension_map else None
            usd = price_per_unit.get("USD") if price_per_unit else None
            if usd is not None:
                return float(usd)
    return None


class _CostExplorerClient(Protocol):
    """The one Cost Explorer call the spend read needs."""

    def get_cost_and_usage(self, **kwargs: Any) -> dict[str, Any]:
        """AWS Cost Explorer GetCostAndUsage."""
        ...


def _default_cost_explorer(
    config: BedrockConnectionConfig, secret_access_key: str
) -> _CostExplorerClient:
    """A tenant-scoped Cost Explorer client (never the ambient chain).

    Cost Explorer is a global API served from us-east-1 regardless of where
    the Bedrock traffic ran, so the connection's region addresses Bedrock
    only, not this client.
    """
    from botocore.config import Config

    return boto3.client(
        "ce",
        region_name="us-east-1",
        aws_access_key_id=config.access_key_id,
        aws_secret_access_key=secret_access_key,
        config=Config(
            connect_timeout=PROBE_TIMEOUT_SECONDS,
            read_timeout=PROBE_TIMEOUT_SECONDS,
            retries={"max_attempts": 1},
        ),
    )


def spend(
    secret_access_key: str,
    config: BedrockConnectionConfig,
    *,
    client_factory: Callable[
        [BedrockConnectionConfig, str], _CostExplorerClient
    ] = _default_cost_explorer,
) -> SpendReport:
    """Read one AWS account's month-to-date Bedrock cost via Cost Explorer.

    Live-tested 2026-08-19. Two realities are load-bearing:

    - The RECORD_TYPE filter MUST exclude Credit and Refund rows, or a
      credit-grant account nets every service to $0.
    - Bedrock spend is spread across per-model SERVICE dimensions ("Claude
      Opus 5 (Amazon Bedrock Edition)") beside "Amazon Bedrock" itself, so
      the sum takes every service naming Bedrock.

    Each query costs $0.01 and the data lags ~24 h — the reason this
    provider's staleness floor is hours, not minutes. AWS exposes no
    credit-balance API; the self-reported gauge covers remaining credits.
    """
    start = month_to_date_start()
    today = datetime.now(tz=UTC).date()
    try:
        client = client_factory(config, secret_access_key)
        response = client.get_cost_and_usage(
            TimePeriod={
                "Start": start.date().isoformat(),
                # End is exclusive; tomorrow includes today's (still lagging) rows.
                "End": (today + timedelta(days=1)).isoformat(),
            },
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            Filter={"Not": {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}}},
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
    except ClientError as error:
        return _spend_client_error(error, config)
    except (BotoCoreError, ValueError) as error:
        return SpendReport(
            kind=SpendReportKind.READ_FAILED,
            detail={"provider_code": type(error).__name__, "provider_message": str(error)},
            message=(
                "AWS Cost Explorer could not be queried with the stored key pair "
                f"({type(error).__name__}). The stored numbers are unchanged; check "
                "the credentials and try again later."
            ),
        )

    total = 0.0
    per_service: dict[str, float] = {}
    estimated = False
    for window in response.get("ResultsByTime", []):
        estimated = bool(window.get("Estimated", False)) or estimated
        for group in window.get("Groups", []):
            service = str(next(iter(group.get("Keys", [])), ""))
            if "Bedrock" not in service:
                continue
            amount = float(group.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", 0))
            per_service[service] = per_service.get(service, 0.0) + amount
            total += amount
    return SpendReport(
        kind=SpendReportKind.REPORTED,
        source=SnapshotSource.OUR_SIDE,
        spend_usd=total,
        detail={
            "per_service_usd": {name: round(value, 6) for name, value in per_service.items()},
            "estimated": estimated,
            "data_lag": "~24h",
        },
        message=(
            "Month-to-date Bedrock cost from AWS Cost Explorer (runs ~24 h "
            "behind). AWS exposes no credit balance; use the self-reported "
            "gauge for remaining credits."
        ),
    )


def _spend_client_error(error: ClientError, config: BedrockConnectionConfig) -> SpendReport:
    """Map one Cost Explorer ClientError onto an honest read failure."""
    aws = error.response.get("Error", {})
    code = str(aws.get("Code", "")) or type(error).__name__
    message = str(aws.get("Message", "")) or str(error)
    if code == "AccessDeniedException":
        remediation = (
            f"The AWS credentials for {config.access_key_id} are real but IAM denies "
            "Cost Explorer access. Attach a policy allowing ce:GetCostAndUsage to the "
            "key's user or role to see Bedrock spend; serving traffic is unaffected."
        )
    else:
        remediation = (
            f"AWS Cost Explorer answered {code} while reading Bedrock spend. The "
            "stored numbers are unchanged; try again later."
        )
    return SpendReport(
        kind=SpendReportKind.READ_FAILED,
        detail={"provider_code": code, "provider_message": message},
        message=remediation,
    )
