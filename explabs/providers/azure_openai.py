# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Azure OpenAI verification: key-level models read plus a per-deployment probe.

Live-tested (2026-08-19):

- Bad key: 401 "Access denied due to invalid subscription key or wrong API
  endpoint."
- Key valid but the model not deployed: POSTing a minimal chat completion to
  the mapped deployment answers 404 with ``error.code == "DeploymentNotFound"``
  and the message "The API deployment for this resource does not exist. …".

The deployment case is the canonical "you have a key, but this model isn't
deployed": deliberately NOT a key status — the key stays ``valid`` and the
(connection x model) fact is computed live by the model page and by traffic.
"""

from __future__ import annotations

import re

import httpx

from explabs.db.stores.provider_connection_store import AzureConnectionConfig, ConnectionStatus
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
)
from explabs.providers.discovery import DiscoveredModel, slugify
from explabs.providers.spend import SpendReport, SpendReportKind

# The dated data-plane version the key-level models read is pinned to; a
# connection's own api_version (when set) takes precedence.
_DEFAULT_API_VERSION = "2024-10-21"

# The backend provider key that scopes Azure rows and their per-org BYOK
# routing (``azure_openai`` is in the gateway's BYOK-routable set); the catalog
# namespace is derived from it. The user-facing label is the Foundry product.
PROVIDER = "azure_openai"
PROVIDER_LABEL = "Azure Foundry"

# The deployments listing answers only on this dated preview version on the
# resources we serve; the newer GA versions 404 that control-plane route.
_DEPLOYMENTS_API_VERSION = "2023-03-15-preview"

DEPLOYMENT_NOT_FOUND_CODE = "DeploymentNotFound"


class AzureDeploymentCheck(ProbeDetail):
    """One (connection x model) deployment fact, key status untouched."""

    deployed: bool


def probe(  # noqa: PLR0911 - one verdict ladder; each branch is a distinct verdict
    credential: str,
    config: AzureConnectionConfig,
    *,
    transport: httpx.BaseTransport | None = None,
) -> ProbeResult:
    """Verify one Azure OpenAI data-plane key against its resource endpoint."""
    endpoint = config.endpoint.rstrip("/")
    url = f"{endpoint}/openai/models"
    try:
        with probe_client(transport) as client:
            response = client.get(
                url,
                params={"api-version": config.api_version or _DEFAULT_API_VERSION},
                headers={"api-key": credential},
            )
    except httpx.HTTPError as error:
        # Unlike the fixed-host providers, the endpoint here is customer
        # input: an unreachable host is almost always a mistyped resource
        # URL, not an Azure outage.
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code=type(error).__name__,
                provider_message=str(error) or None,
                remediation=(
                    f"The Azure endpoint {config.endpoint} could not be reached "
                    f"({type(error).__name__}). Check the resource endpoint — it is the "
                    "https://<resource>.openai.azure.com URL on the resource's Keys and "
                    "Endpoint page — and save again."
                ),
            ),
        )

    if response.is_success:
        return ProbeResult(
            status=ConnectionStatus.VALID,
            detail=ProbeDetail(
                provider_status=response.status_code,
                remediation="The Azure OpenAI key works against this resource endpoint.",
            ),
        )

    code = response_error_field(response, "code")
    message = response_message(response)
    if response.status_code == 401:
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=401,
                provider_code=code,
                provider_message=message,
                remediation=(
                    f"Azure rejected the key ending {masked(credential)} for "
                    f"{config.endpoint}: invalid subscription key or wrong endpoint. Keys "
                    "are per-resource — copy KEY 1 from THIS resource's Keys and Endpoint "
                    "page, and make sure the endpoint URL belongs to the same resource."
                ),
            ),
        )
    if response.status_code == 404:
        # A 200-host answering 404 on /openai/models is a real server that is
        # not an Azure OpenAI resource (or a wrong path): endpoint problem.
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_status=404,
                provider_code=code,
                provider_message=message,
                remediation=(
                    f"{config.endpoint} answered 404 for the Azure OpenAI models API — the "
                    "endpoint does not look like an Azure OpenAI resource. Use the "
                    "https://<resource>.openai.azure.com URL from the resource's Keys and "
                    "Endpoint page."
                ),
            ),
        )
    if response.status_code == 429:
        return rate_limited("Azure OpenAI", response)
    if response.status_code >= 500:
        return server_error("Azure OpenAI", response)
    return ProbeResult(
        status=ConnectionStatus.INVALID,
        detail=ProbeDetail(
            provider_status=response.status_code,
            provider_code=code,
            provider_message=message,
            remediation=(
                f"Azure refused the key ending {masked(credential)} with HTTP "
                f"{response.status_code}. Check the key and endpoint on the resource's "
                "Keys and Endpoint page."
            ),
        ),
    )


def probe_deployment(
    credential: str,
    config: AzureConnectionConfig,
    deployment: str,
    *,
    transport: httpx.BaseTransport | None = None,
) -> AzureDeploymentCheck:
    """Whether one mapped deployment actually exists on the resource.

    A minimal one-token chat completion is the cheapest call that resolves a
    deployment; any answer other than DeploymentNotFound (including request
    validation errors) proves the deployment exists.

    Raises:
        httpx.HTTPError: When the resource cannot be reached at all; the
            caller already holds the key-level verdict for that case.
    """
    endpoint = config.endpoint.rstrip("/")
    url = f"{endpoint}/openai/deployments/{deployment}/chat/completions"
    with probe_client(transport) as client:
        response = client.post(
            url,
            params={"api-version": config.api_version or _DEFAULT_API_VERSION},
            headers={"api-key": credential},
            json={"messages": [{"role": "user", "content": "ping"}], "max_tokens": 1},
        )
    code = response_error_field(response, "code")
    message = response_message(response)
    if response.status_code == 404 and code == DEPLOYMENT_NOT_FOUND_CODE:
        return AzureDeploymentCheck(
            deployed=False,
            provider_status=404,
            provider_code=code,
            provider_message=message,
            remediation=(
                f"You have a key, but this model isn't deployed: the resource has no "
                f"deployment named {deployment!r}. Create the deployment in Azure AI "
                "Foundry (deployments take a few minutes to appear) or fix the deployment "
                "name mapped to this model."
            ),
        )
    return AzureDeploymentCheck(
        deployed=True,
        provider_status=response.status_code,
        provider_code=code,
        remediation=f"The deployment {deployment!r} exists on {config.endpoint}.",
    )


def list_models(
    credential: str,
    endpoint: str,
    *,
    api_version: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> tuple[DiscoveredModel, ...]:
    """Mirror the ENTIRE Azure model catalog this resource exposes (1:1).

    Reads the resource's model catalog ``GET /openai/models`` — every model the
    endpoint lists, chat and non-chat alike — and its live deployments
    ``GET /openai/deployments``. Funding lane by whether the house key can
    already serve the model:

    - A chat model with a live (``succeeded``) deployment on this resource is
      house-servable, so it is ``host_managed`` (priced-or-hidden — Azure
      exposes no price API to a data-plane key, so it stays hidden until a
      hand-curated price lands, and its route resolves through the house
      connection's deployment mapping).
    - Every other chat model is ``customer_managed`` (BYOK-by-default): the
      caller funds it with their own Azure connection, routed per-org
      (``azure_openai`` is BYOK-routable), with a fail-closed error for a caller
      who brings no key.
    - Non-chat models (embeddings, image, audio, completion-only) are listed for
      completeness but marked non-servable — no chat route is built for them.

    The deployments read degrades to "no house deployments" (every chat row
    BYOK) if the control-plane route is unavailable, rather than failing the run.

    Args:
        credential: An Azure OpenAI data-plane key for ``endpoint``.
        endpoint: The resource endpoint (``https://<resource>.openai.azure.com``).
        api_version: Catalog data-plane version; defaults to the pinned one.
        transport: Test seam for the HTTP client.

    Returns:
        One price-less record per catalog model, sorted by slug.

    Raises:
        httpx.HTTPError: The catalog listing could not be read.
    """
    base = _resource_base(endpoint)
    version = api_version or _DEFAULT_API_VERSION
    with probe_client(transport) as client:
        catalog_response = client.get(
            f"{base}/openai/models",
            params={"api-version": version},
            headers={"api-key": credential},
        )
        catalog_response.raise_for_status()
        deployments_response = client.get(
            f"{base}/openai/deployments",
            params={"api-version": _DEPLOYMENTS_API_VERSION},
            headers={"api-key": credential},
        )
    deployed = _deployed_base_models(deployments_response)
    catalog = json_object(catalog_response.json())
    rows = catalog.get("data") if catalog else None
    # The catalog lists some ids twice; dedupe by slug (first wins) so the sync
    # upserts one row per model rather than reprocessing identical duplicates.
    discovered: dict[str, DiscoveredModel] = {}
    for row in rows if isinstance(rows, list) else []:
        record = json_object(row)
        model = _catalog_model(record, deployed) if record is not None else None
        if model is not None and model.slug not in discovered:
            discovered[model.slug] = model
    return tuple(sorted(discovered.values(), key=lambda model: model.slug))


def _deployed_base_models(response: httpx.Response) -> frozenset[str]:
    """Base model ids with a live deployment on the resource (empty if unread).

    A non-2xx deployments read (the route 404s on some api-versions/resources)
    degrades to an empty set: every chat row then falls to the BYOK lane rather
    than being wrongly claimed house-servable.
    """
    if not response.is_success:
        return frozenset()
    body = json_object(response.json())
    rows = body.get("data") if body else None
    deployed: set[str] = set()
    for row in rows if isinstance(rows, list) else []:
        record = json_object(row)
        if record is None or record.get("status") != "succeeded":
            continue
        model = record.get("model")
        if isinstance(model, str) and model:
            deployed.add(model)
    return frozenset(deployed)


def _catalog_model(record: dict[str, object], deployed: frozenset[str]) -> DiscoveredModel | None:
    """Map one catalog model to a record, or ``None`` when it has no id."""
    model_id = str(record.get("id", ""))
    if not model_id:
        return None
    capabilities = json_object(record.get("capabilities"))
    servable = bool(capabilities.get("chat_completion")) if capabilities is not None else False
    # House-servable = a live deployment backs this chat model; that is the
    # platform-funded lane. Everything else the caller funds with their own key.
    billing = "host_managed" if (servable and model_id in deployed) else "customer_managed"
    return DiscoveredModel(
        slug=slugify(PROVIDER, model_id),
        display_name=f"{_prettify(model_id)} ({PROVIDER_LABEL})",
        provider=PROVIDER,
        provider_model_id=model_id,
        input_modalities=("text",),
        supported_params={},
        capabilities={"supports_streaming": True} if servable else {},
        price=None,
        billing_source=billing,
        servable=servable,
    )


def _resource_base(endpoint: str) -> str:
    """The resource root, tolerating an inference-base endpoint.

    The stored Foundry endpoint is the ``/openai/v1/`` inference base; the
    catalog and deployments control-plane routes hang off the resource root, so
    strip a trailing ``/openai/v1`` or ``/openai`` before appending them.
    """
    base = endpoint.rstrip("/")
    for suffix in ("/openai/v1", "/openai"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def _prettify(model_id: str) -> str:
    """A readable display name from an Azure model id (e.g. ``gpt-4o-mini``)."""
    return " ".join(word.capitalize() for word in re.split(r"[-_]", model_id) if word)


def spend() -> SpendReport:
    """Azure's honest empty state: a data-plane key reads no billing.

    Live-verified 2026-08-19: the stored credential is a data-plane API key,
    which can read nothing from Cost Management, and our own subscription is
    a SPONSORSHIP one where even ARM Cost Management returns 200 with empty
    rows (the real balance is browser-only at microsoftazuresponsorships.com).
    Provider note, deliberately not built for launch: on normal MCA/PAYG
    subscriptions ARM Cost Management does work with service-principal
    credentials and a ~4-24 h lag — that would be a different credential kind
    than this connection stores.
    """
    return SpendReport(
        kind=SpendReportKind.NOT_REPORTABLE,
        message=(
            "Azure doesn't report spend to a data-plane API key, and "
            "sponsorship subscriptions expose their balance only in the "
            "Azure sponsorship portal. Use the self-reported gauge to track "
            "remaining credit."
        ),
    )
