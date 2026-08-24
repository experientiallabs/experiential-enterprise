# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Fireworks probe verdicts against recorded provider responses."""

from __future__ import annotations

from collections.abc import Mapping

import httpx
import pytest

from explabs.db.stores.provider_connection_store import ConnectionStatus, FireworksConnectionConfig
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers import fireworks
from explabs.providers.spend import SpendReportKind

KEY = "fw_test_key_abcd1234"


def _transport(status_code: int, payload: Mapping[str, object]) -> httpx.MockTransport:
    return httpx.MockTransport(lambda _request: httpx.Response(status_code, json=payload))


def test_a_working_key_is_valid() -> None:
    """200 on the models list proves the key."""
    result = fireworks.probe(KEY, transport=_transport(200, {"object": "list", "data": []}))
    assert result.status is ConnectionStatus.VALID


def test_a_rejected_key_is_invalid_on_401_and_403() -> None:
    """Fireworks answers both codes for credential problems."""
    for status_code in (401, 403):
        result = fireworks.probe(
            KEY, transport=_transport(status_code, {"error": {"message": "invalid API key"}})
        )
        assert result.status is ConnectionStatus.INVALID
        assert "fireworks.ai" in result.detail.remediation


def test_out_of_credit_is_quota_exhausted() -> None:
    """402 means the account cannot buy inference; the key stays right."""
    result = fireworks.probe(
        KEY, transport=_transport(402, {"error": {"message": "insufficient balance"}})
    )
    assert result.status is ConnectionStatus.QUOTA_EXHAUSTED


def test_throttling_is_rate_limited_and_5xx_is_their_outage() -> None:
    """429 → rate_limited; 5xx → provider_error."""
    throttled = fireworks.probe(KEY, transport=_transport(429, {"error": {"message": "slow down"}}))
    assert throttled.status is ConnectionStatus.RATE_LIMITED
    outage = fireworks.probe(KEY, transport=_transport(500, {"error": {"message": "internal"}}))
    assert outage.status is ConnectionStatus.PROVIDER_ERROR


def test_an_unreachable_provider_is_provider_error() -> None:
    """Network failure means our check failed, not their credential."""

    def raise_connect_error(request: httpx.Request) -> httpx.Response:
        msg = "connection refused"
        raise httpx.ConnectError(msg, request=request)

    result = fireworks.probe(KEY, transport=httpx.MockTransport(raise_connect_error))
    assert result.status is ConnectionStatus.PROVIDER_ERROR


CONFIG = FireworksConnectionConfig.model_validate({"account_id": "experiential-labs"})

# The recorded billing summary shape (live, 2026-08-19): protobuf Money with
# int64 units as a JSON STRING beside int nanos; quantities can be string too.
BILLING_PAYLOAD = {
    "lineItems": [
        {
            "category": "LLM input tokens (cached)",
            "groupingKey": "model_bucket",
            "groupingValue": "GLM 5.2",
            "quantity": "3842372426",
            "series": "SERVERLESS",
            "totalCost": {"currencyCode": "USD", "units": "537", "nanos": 932139640},
        },
        {
            "category": "LLM output tokens",
            "groupingKey": "model_bucket",
            "groupingValue": "GLM 5.2",
            "quantity": 88415929,
            "series": "SERVERLESS",
            "totalCost": {"currencyCode": "USD", "units": "389", "nanos": 30087600},
        },
    ],
    "usageBuckets": [],
}


def test_spend_sums_string_int64_money_line_items() -> None:
    """Live shape: Money.units is a JSON string; nanos are int billionths."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["startTime"] = request.url.params.get("startTime", "")
        return httpx.Response(200, json=BILLING_PAYLOAD)

    report = fireworks.spend(KEY, CONFIG, transport=httpx.MockTransport(handler))
    assert report.kind is SpendReportKind.REPORTED
    assert report.source is SnapshotSource.PROVIDER_API
    assert report.spend_usd == pytest.approx(537.932139640 + 389.030087600)
    assert seen["path"] == "/v1/accounts/experiential-labs/billing/summary"
    # Fireworks refuses bare dates; the timestamps must be full RFC3339.
    assert seen["startTime"].endswith("T00:00:00Z")
    assert report.detail is not None
    assert report.detail["line_items"] == 2


def test_spend_names_the_account_id_on_a_refused_read() -> None:
    """403/404 usually means the account id doesn't match the key's account."""
    report = fireworks.spend(
        KEY,
        CONFIG,
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(404, json={"message": "account not found"})
        ),
    )
    assert report.kind is SpendReportKind.READ_FAILED
    assert "experiential-labs" in report.message
    assert "account id" in report.message


def test_spend_read_failure_is_honest_on_other_errors() -> None:
    """A 500 keeps the stored numbers and reports the status."""
    report = fireworks.spend(
        KEY,
        CONFIG,
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(500, json={"message": "internal"})
        ),
    )
    assert report.kind is SpendReportKind.READ_FAILED
    assert "500" in report.message


_PAGE_ONE = {
    "models": [
        {
            "name": "accounts/fireworks/models/kimi-k2p6",
            "kind": "HF_BASE_MODEL",
            "supportsServerless": True,
            "supportsImageInput": True,
            "supportsTools": True,
            "contextLength": 262144,
        },
        {
            "name": "accounts/fireworks/models/some-community-13b",
            "kind": "HF_BASE_MODEL",
            "supportsServerless": False,
            "supportsImageInput": False,
            "supportsTools": False,
            "contextLength": 4096,
        },
    ],
    "nextPageToken": "page-2",
}
_PAGE_TWO = {
    "models": [
        {
            "name": "accounts/fireworks/models/qwen3-embedding-8b",
            "kind": "EMBEDDING_MODEL",
            "supportsServerless": False,
            "contextLength": 40960,
        }
    ]
}


def _library_transport() -> httpx.MockTransport:
    """Serve the paginated control-plane library across two pages."""

    def handler(request: httpx.Request) -> httpx.Response:
        page = _PAGE_TWO if request.url.params.get("pageToken") == "page-2" else _PAGE_ONE
        return httpx.Response(200, json=page)

    return httpx.MockTransport(handler)


def test_list_models_mirrors_the_whole_library_across_pages() -> None:
    """Every library model is returned, following nextPageToken pagination."""
    models = {
        model.slug: model for model in fireworks.list_models(KEY, transport=_library_transport())
    }
    assert set(models) == {
        "fireworks-models-kimi-k2p6",
        "fireworks-models-some-community-13b",
        "fireworks-models-qwen3-embedding-8b",
    }
    assert all(model.provider == "fireworks" for model in models.values())
    assert all(model.price is None for model in models.values())


def test_list_models_assigns_funding_lane_and_servability() -> None:
    """Serverless chat is host_managed; other chat is BYOK; non-chat is listed unservable."""
    models = {
        model.slug: model for model in fireworks.list_models(KEY, transport=_library_transport())
    }

    serverless = models["fireworks-models-kimi-k2p6"]
    assert serverless.billing_source == "host_managed"
    assert serverless.servable is True
    assert serverless.capabilities == {"supports_streaming": True}
    assert serverless.input_modalities == ("text", "image")
    assert serverless.context_window == 262144
    assert serverless.supported_params == {"tools": True}

    community = models["fireworks-models-some-community-13b"]
    assert community.billing_source == "customer_managed"
    assert community.servable is True

    embedding = models["fireworks-models-qwen3-embedding-8b"]
    assert embedding.servable is False
    assert dict(embedding.capabilities) == {}
    assert embedding.billing_source == "customer_managed"


def test_list_models_raises_on_a_failed_listing() -> None:
    """A non-2xx listing is a hard failure, not a silent empty catalog."""
    with pytest.raises(httpx.HTTPStatusError):
        fireworks.list_models(KEY, transport=_transport(401, {"error": {"message": "bad key"}}))
