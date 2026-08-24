# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Azure OpenAI probe verdicts, including the canonical deployment case."""

from __future__ import annotations

from collections.abc import Mapping

import httpx
import pytest

from explabs.db.stores.provider_connection_store import AzureConnectionConfig, ConnectionStatus
from explabs.providers import azure_openai
from explabs.providers.spend import SpendReportKind

KEY = "0123456789abcdef0123456789abwxyz"

CONFIG = AzureConnectionConfig.model_validate(
    {
        "endpoint": "https://my-resource.openai.azure.com",
        "deployments": {"gpt-5.5": "my-gpt-55"},
    }
)


def _transport(status_code: int, payload: Mapping[str, object]) -> httpx.MockTransport:
    return httpx.MockTransport(lambda _request: httpx.Response(status_code, json=payload))


def test_a_working_key_is_valid_and_addresses_the_stored_resource() -> None:
    """The models read rides the connection's endpoint with the api-key header."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["api-key"] = request.headers.get("api-key", "")
        return httpx.Response(200, json={"data": []})

    result = azure_openai.probe(KEY, CONFIG, transport=httpx.MockTransport(handler))
    assert result.status is ConnectionStatus.VALID
    assert seen["url"].startswith("https://my-resource.openai.azure.com/openai/models")
    assert "api-version=2024-10-21" in seen["url"]
    assert seen["api-key"] == KEY


def test_the_connections_own_api_version_wins_over_the_default() -> None:
    """A stored api_version is the customer's contract; the probe must use it."""
    config = AzureConnectionConfig.model_validate(
        {
            "endpoint": "https://my-resource.openai.azure.com",
            "api_version": "2025-01-01-preview",
            "deployments": {"gpt-5.5": "my-gpt-55"},
        }
    )
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["api-version"] = request.url.params.get("api-version", "")
        return httpx.Response(200, json={"data": []})

    azure_openai.probe(KEY, config, transport=httpx.MockTransport(handler))
    assert seen["api-version"] == "2025-01-01-preview"


def test_a_rejected_key_is_invalid_with_the_recorded_azure_message() -> None:
    """Recorded shape (live-tested): 401 invalid subscription key."""
    payload = {
        "error": {
            "code": "401",
            "message": (
                "Access denied due to invalid subscription key or wrong API endpoint. "
                "Make sure to provide a valid key for an active subscription and use a "
                "correct regional API endpoint for your resource."
            ),
        }
    }
    result = azure_openai.probe(KEY, CONFIG, transport=_transport(401, payload))
    assert result.status is ConnectionStatus.INVALID
    assert "invalid subscription key" in (result.detail.provider_message or "")
    assert "Keys and Endpoint" in result.detail.remediation


def test_a_wrong_endpoint_is_invalid_with_endpoint_remediation() -> None:
    """An unreachable endpoint is customer input, not an Azure outage."""

    def raise_connect_error(request: httpx.Request) -> httpx.Response:
        msg = "nodename nor servname provided"
        raise httpx.ConnectError(msg, request=request)

    result = azure_openai.probe(KEY, CONFIG, transport=httpx.MockTransport(raise_connect_error))
    assert result.status is ConnectionStatus.INVALID
    assert "https://my-resource.openai.azure.com" in result.detail.remediation
    assert "endpoint" in result.detail.remediation.lower()


def test_a_404_on_the_models_api_means_not_an_azure_openai_resource() -> None:
    """A live host that 404s the models path is the wrong-endpoint case."""
    result = azure_openai.probe(KEY, CONFIG, transport=_transport(404, {}))
    assert result.status is ConnectionStatus.INVALID
    assert "does not look like an Azure OpenAI resource" in result.detail.remediation


def test_throttling_and_5xx_do_not_blame_the_key() -> None:
    """429 → rate_limited; 5xx → provider_error."""
    throttled = azure_openai.probe(
        KEY, CONFIG, transport=_transport(429, {"error": {"code": "429", "message": "busy"}})
    )
    assert throttled.status is ConnectionStatus.RATE_LIMITED
    outage = azure_openai.probe(
        KEY, CONFIG, transport=_transport(503, {"error": {"message": "unavailable"}})
    )
    assert outage.status is ConnectionStatus.PROVIDER_ERROR


def test_a_missing_deployment_is_a_model_fact_with_the_canonical_message() -> None:
    """The canonical case: you have a key, but this model isn't deployed.

    Recorded shape (live-tested): 404 DeploymentNotFound. The key-level status
    is untouched — this is a per-model fact, not a key verdict.
    """
    payload = {
        "error": {
            "code": "DeploymentNotFound",
            "message": (
                "The API deployment for this resource does not exist. If you created the "
                "deployment within the last 5 minutes, please wait a moment and try again."
            ),
        }
    }
    check = azure_openai.probe_deployment(
        KEY, CONFIG, "my-gpt-55", transport=_transport(404, payload)
    )
    assert check.deployed is False
    assert check.provider_code == "DeploymentNotFound"
    assert "this model isn't deployed" in check.remediation
    assert "my-gpt-55" in check.remediation


def test_any_non_deployment_answer_proves_the_deployment_exists() -> None:
    """Even a request-validation 400 resolves the deployment name."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/openai/deployments/my-gpt-55/chat/completions"
        return httpx.Response(
            400, json={"error": {"code": "BadRequest", "message": "max_tokens too small"}}
        )

    check = azure_openai.probe_deployment(
        KEY, CONFIG, "my-gpt-55", transport=httpx.MockTransport(handler)
    )
    assert check.deployed is True


def test_spend_is_honestly_not_reportable() -> None:
    """Data-plane keys read no billing; sponsorship balances are browser-only."""
    report = azure_openai.spend()
    assert report.kind is SpendReportKind.NOT_REPORTABLE
    assert "data-plane" in report.message
    assert "self-reported" in report.message


# --- Full catalog mirror ---------------------------------------------------

_FOUNDRY = "https://example-foundry.services.ai.azure.com/openai/v1/"

_CATALOG = {
    "data": [
        {"id": "grok-4.3", "capabilities": {"chat_completion": True, "inference": True}},
        {"id": "gpt-5.4", "capabilities": {"chat_completion": True, "inference": True}},
        {"id": "community-chat-13b", "capabilities": {"chat_completion": True, "inference": True}},
        {"id": "text-embedding-3-large", "capabilities": {"embeddings": True, "inference": True}},
        {"id": "dall-e-3-3.0", "capabilities": {"inference": True}},
        {"id": "", "capabilities": {"chat_completion": True}},
    ]
}
_DEPLOYMENTS = {
    "data": [
        {"id": "grok-4.3", "model": "grok-4.3", "status": "succeeded"},
        # A failed deployment must not confer house-serve status.
        {"id": "gpt-5.4", "model": "gpt-5.4", "status": "failed"},
    ]
}


def _catalog_transport(
    *, deployments_status: int = 200, seen: dict[str, str] | None = None
) -> httpx.MockTransport:
    """Serve the catalog on /openai/models and deployments on /openai/deployments."""

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen[request.url.path] = str(request.url)
        if request.url.path.endswith("/openai/deployments"):
            return httpx.Response(deployments_status, json=_DEPLOYMENTS)
        return httpx.Response(200, json=_CATALOG)

    return httpx.MockTransport(handler)


def test_list_models_mirrors_the_whole_catalog_with_servability() -> None:
    """Every catalog model is listed; only chat_completion rows are servable."""
    models = {
        model.slug: model
        for model in azure_openai.list_models(KEY, _FOUNDRY, transport=_catalog_transport())
    }
    # Empty-id rows are dropped; every other catalog model is listed.
    assert set(models) == {
        "azure_openai-grok-4.3",
        "azure_openai-gpt-5.4",
        "azure_openai-community-chat-13b",
        "azure_openai-text-embedding-3-large",
        "azure_openai-dall-e-3-3.0",
    }
    assert all(model.provider == "azure_openai" for model in models.values())
    assert all(model.price is None for model in models.values())
    # Display label is the Foundry product, not the backend provider key.
    assert models["azure_openai-grok-4.3"].display_name.endswith("(Azure Foundry)")


def test_list_models_assigns_funding_lane_and_servability() -> None:
    """Deployed chat is host_managed; other chat is BYOK; non-chat is unservable."""
    models = {
        model.slug: model
        for model in azure_openai.list_models(KEY, _FOUNDRY, transport=_catalog_transport())
    }

    # A live (succeeded) deployment makes the chat model house-servable.
    grok = models["azure_openai-grok-4.3"]
    assert grok.billing_source == "host_managed"
    assert grok.servable is True
    assert grok.capabilities == {"supports_streaming": True}

    # A chat model whose only deployment FAILED is not house-servable → BYOK.
    assert models["azure_openai-gpt-5.4"].billing_source == "customer_managed"
    assert models["azure_openai-gpt-5.4"].servable is True

    # A chat model with no deployment is BYOK-by-default.
    assert models["azure_openai-community-chat-13b"].billing_source == "customer_managed"
    assert models["azure_openai-community-chat-13b"].servable is True

    # Non-chat rows are listed but never given a chat route.
    for slug in ("azure_openai-text-embedding-3-large", "azure_openai-dall-e-3-3.0"):
        assert models[slug].servable is False
        assert dict(models[slug].capabilities) == {}
        assert models[slug].billing_source == "customer_managed"


def test_list_models_targets_the_resource_root_from_an_inference_base() -> None:
    """The /openai/v1/ inference base is normalized to the resource root."""
    seen: dict[str, str] = {}
    azure_openai.list_models(KEY, _FOUNDRY, transport=_catalog_transport(seen=seen))
    catalog_url = seen["/openai/models"]
    assert catalog_url.startswith("https://example-foundry.services.ai.azure.com/openai/models")
    assert "/openai/v1/openai/models" not in catalog_url
    assert "api-version=2024-10-21" in catalog_url


def test_list_models_degrades_to_byok_when_deployments_unreadable() -> None:
    """A 404 on the deployments route lists every chat row as BYOK, not house-served."""
    models = {
        model.slug: model
        for model in azure_openai.list_models(
            KEY, _FOUNDRY, transport=_catalog_transport(deployments_status=404)
        )
    }
    assert models["azure_openai-grok-4.3"].billing_source == "customer_managed"
    assert all(
        model.billing_source == "customer_managed" for model in models.values() if model.servable
    )


def test_list_models_dedupes_catalog_ids_listed_twice() -> None:
    """The Azure catalog lists some ids twice; each yields exactly one row."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/openai/deployments"):
            return httpx.Response(200, json={"data": []})
        duplicated = {
            "data": [
                {"id": "grok-4.3", "capabilities": {"chat_completion": True}},
                {"id": "grok-4.3", "capabilities": {"chat_completion": True}},
            ]
        }
        return httpx.Response(200, json=duplicated)

    models = azure_openai.list_models(KEY, _FOUNDRY, transport=httpx.MockTransport(handler))
    assert [model.slug for model in models] == ["azure_openai-grok-4.3"]


def test_list_models_raises_on_a_failed_catalog_read() -> None:
    """A non-2xx catalog listing surfaces as an HTTP error, not a silent empty."""
    with pytest.raises(httpx.HTTPStatusError):
        azure_openai.list_models(KEY, _FOUNDRY, transport=_transport(500, {"error": "nope"}))
