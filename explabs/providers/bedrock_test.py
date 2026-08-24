# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Bedrock probe verdicts against recorded AWS error shapes."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from explabs.db.stores.provider_connection_store import BedrockConnectionConfig, ConnectionStatus
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers import bedrock
from explabs.providers.accounts import ProbeResult
from explabs.providers.spend import SpendReportKind

SECRET = "aws-secret-access-key-value"

CONFIG = BedrockConnectionConfig.model_validate(
    {"region": "us-east-1", "access_key_id": "AKIAEXAMPLEEXAMPLE"}
)


class _FakeBedrockClient:
    """A control-plane client that answers ListFoundationModels one fixed way."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    def list_foundation_models(self) -> dict[str, Any]:
        if self.error is not None:
            raise self.error
        return {"modelSummaries": [{"modelId": "anthropic.claude-opus-5"}]}


def _client_error(code: str, message: str, status: int) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": code, "Message": message},
            "ResponseMetadata": {"HTTPStatusCode": status},
        },
        "ListFoundationModels",
    )


def _probe_with(error: Exception | None) -> ProbeResult:
    return bedrock.probe(
        SECRET, CONFIG, client_factory=lambda _config, _secret: _FakeBedrockClient(error)
    )


def test_a_working_key_pair_is_valid() -> None:
    """A successful listing proves the credentials in the stored region."""
    result = _probe_with(None)
    assert result.status is ConnectionStatus.VALID
    assert "us-east-1" in result.detail.remediation


def test_dead_credentials_are_invalid() -> None:
    """Recorded shape: UnrecognizedClientException for a bad key pair."""
    result = _probe_with(
        _client_error(
            "UnrecognizedClientException",
            "The security token included in the request is invalid.",
            403,
        )
    )
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_code == "UnrecognizedClientException"
    assert "AKIAEXAMPLEEXAMPLE" in result.detail.remediation


def test_a_wrong_secret_for_a_real_id_is_invalid() -> None:
    """Recorded shape: InvalidSignatureException when the secret half is wrong."""
    result = _probe_with(
        _client_error(
            "InvalidSignatureException",
            "The request signature we calculated does not match the signature you provided.",
            403,
        )
    )
    assert result.status is ConnectionStatus.INVALID


def test_real_credentials_without_bedrock_permission_name_the_policy() -> None:
    """IAM errors map to invalid, with the missing permission spelled out."""
    result = _probe_with(
        _client_error(
            "AccessDeniedException",
            "User: arn:aws:iam::123:user/x is not authorized to perform: bedrock:ListFoundationModels",
            403,
        )
    )
    assert result.status is ConnectionStatus.INVALID
    assert "bedrock:ListFoundationModels" in result.detail.remediation


def test_a_bad_region_gets_its_own_remediation() -> None:
    """Region errors are the region field's fault, not the key pair's."""
    result = _probe_with(
        EndpointConnectionError(endpoint_url="https://bedrock.us-eest-1.amazonaws.com")
    )
    assert result.status is ConnectionStatus.INVALID
    assert "'us-east-1'" in result.detail.remediation
    assert "region" in result.detail.remediation.lower()


def test_throttling_is_rate_limited() -> None:
    """ThrottlingException keeps the credentials acceptable."""
    result = _probe_with(_client_error("ThrottlingException", "Rate exceeded", 429))
    assert result.status is ConnectionStatus.RATE_LIMITED


def test_an_aws_5xx_is_their_outage() -> None:
    """Server-side AWS failures must not blame the credentials."""
    result = _probe_with(_client_error("InternalFailure", "Internal error", 500))
    assert result.status is ConnectionStatus.PROVIDER_ERROR
    assert "not your key pair" in result.detail.remediation


# The recorded Cost Explorer response shape (live, 2026-08-19): Bedrock spend
# spread across per-model SERVICE names beside "Amazon Bedrock" itself, with
# unrelated services in the same account.
_CE_RESPONSE: dict[str, Any] = {
    "ResultsByTime": [
        {
            "TimePeriod": {"Start": "2026-08-01", "End": "2026-08-19"},
            "Estimated": True,
            "Groups": [
                {
                    "Keys": ["Amazon Bedrock"],
                    "Metrics": {"UnblendedCost": {"Amount": "0.00567846", "Unit": "USD"}},
                },
                {
                    "Keys": ["Claude Opus 5 (Amazon Bedrock Edition)"],
                    "Metrics": {"UnblendedCost": {"Amount": "20.3171045", "Unit": "USD"}},
                },
                {
                    "Keys": ["Amazon Simple Storage Service"],
                    "Metrics": {"UnblendedCost": {"Amount": "0.0031911235", "Unit": "USD"}},
                },
            ],
        }
    ],
}


class _FakeCostExplorer:
    """Records the query and answers with a canned Cost Explorer response."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.queries: list[dict[str, Any]] = []

    def get_cost_and_usage(self, **kwargs: Any) -> dict[str, Any]:
        self.queries.append(kwargs)
        if self.error is not None:
            raise self.error
        return _CE_RESPONSE


def test_spend_sums_only_bedrock_services_and_filters_credits() -> None:
    """Live realities of the Cost Explorer read.

    Bedrock spans per-model SERVICE names, and the query MUST exclude
    Credit/Refund record types or credit accounts net to $0.
    """
    fake = _FakeCostExplorer()
    report = bedrock.spend(SECRET, CONFIG, client_factory=lambda _config, _secret: fake)
    assert report.kind is SpendReportKind.REPORTED
    assert report.source is SnapshotSource.OUR_SIDE
    assert report.spend_usd == pytest.approx(0.00567846 + 20.3171045)
    assert report.detail is not None
    per_service = report.detail["per_service_usd"]
    assert isinstance(per_service, dict)
    assert "Amazon Simple Storage Service" not in per_service
    query = fake.queries[0]
    assert query["Filter"] == {
        "Not": {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}}
    }
    assert query["GroupBy"] == [{"Type": "DIMENSION", "Key": "SERVICE"}]


def test_spend_without_cost_explorer_permission_names_the_policy() -> None:
    """Real serving credentials may lack ce:GetCostAndUsage; say exactly that."""
    fake = _FakeCostExplorer(
        error=_client_error("AccessDeniedException", "not authorized to perform ce:*", 403)
    )
    report = bedrock.spend(SECRET, CONFIG, client_factory=lambda _config, _secret: fake)
    assert report.kind is SpendReportKind.READ_FAILED
    assert "ce:GetCostAndUsage" in report.message
    assert "serving traffic is unaffected" in report.message


def test_spend_read_failure_is_honest_on_other_aws_errors() -> None:
    """Any other AWS rejection keeps stored numbers and reports the code."""
    fake = _FakeCostExplorer(error=_client_error("ThrottlingException", "slow down", 429))
    report = bedrock.spend(SECRET, CONFIG, client_factory=lambda _config, _secret: fake)
    assert report.kind is SpendReportKind.READ_FAILED
    assert "ThrottlingException" in report.message


class _FakeCatalogClient:
    """A per-region control-plane client for discovery tests."""

    def __init__(self, summaries: list[dict[str, Any]], profiles: list[dict[str, Any]]) -> None:
        self._summaries = summaries
        self._profiles = profiles

    def list_foundation_models(self) -> dict[str, Any]:
        return {"modelSummaries": self._summaries}

    def list_inference_profiles(self, **_kwargs: Any) -> dict[str, Any]:
        return {"inferenceProfileSummaries": self._profiles}


def _summary(model_id: str, **overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "modelId": model_id,
        "modelName": model_id.rsplit(".", 1)[-1],
        "outputModalities": ["TEXT"],
        "inputModalities": ["TEXT"],
        "responseStreamingSupported": True,
        "inferenceTypesSupported": ["ON_DEMAND"],
        "modelLifecycle": {"status": "ACTIVE"},
    }
    row.update(overrides)
    return row


def test_list_models_mirrors_all_active_models_marking_servability() -> None:
    """Every ACTIVE model is listed; only chat-invocable rows are servable."""
    summaries = [
        _summary("deepseek.v3.2"),
        _summary("amazon.titan-embed", outputModalities=["EMBEDDING"]),
        _summary("stability.image", outputModalities=["IMAGE"]),
        _summary("legacy.model", modelLifecycle={"status": "LEGACY"}),
        _summary("noecho.model", responseStreamingSupported=False),
        _summary("orphan.profileless", inferenceTypesSupported=["INFERENCE_PROFILE"]),
    ]
    models = {
        m.slug: m
        for m in bedrock.list_models(
            "AKIA",
            SECRET,
            regions=["us-east-1"],
            client_factory=lambda *_a: _FakeCatalogClient(summaries, []),
        )
    }
    # LEGACY is dropped; every other ACTIVE model is listed for completeness.
    assert set(models) == {
        "bedrock-deepseek.v3.2",
        "bedrock-amazon.titan-embed",
        "bedrock-stability.image",
        "bedrock-noecho.model",
        "bedrock-orphan.profileless",
    }
    # Only the TEXT + streaming + invocable model is servable.
    assert models["bedrock-deepseek.v3.2"].servable is True
    assert models["bedrock-deepseek.v3.2"].capabilities == {"supports_streaming": True}
    for slug in ("bedrock-amazon.titan-embed", "bedrock-stability.image", "bedrock-noecho.model"):
        assert models[slug].servable is False
        assert dict(models[slug].capabilities) == {}
    # All Bedrock rows are host_managed (BYOK Bedrock is not yet routable).
    assert all(m.billing_source == "host_managed" for m in models.values())


def test_list_models_routes_profile_only_models_through_their_profile() -> None:
    """A model that is not ON_DEMAND is reached through its inference profile id."""
    summaries = [_summary("anthropic.claude-x", inferenceTypesSupported=["INFERENCE_PROFILE"])]
    profiles = [
        {
            "inferenceProfileId": "us.anthropic.claude-x",
            "models": [
                {"modelArn": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-x"}
            ],
        }
    ]
    models = bedrock.list_models(
        "AKIA",
        SECRET,
        regions=["us-east-1"],
        client_factory=lambda *_a: _FakeCatalogClient(summaries, profiles),
    )
    assert models[0].provider_model_id == "us.anthropic.claude-x"


def test_list_models_deduplicates_across_regions_first_region_wins() -> None:
    """A model served in both regions is one row tagged with the first region."""
    clients = {
        "us-east-1": _FakeCatalogClient([_summary("deepseek.v3.2")], []),
        "us-west-2": _FakeCatalogClient([_summary("deepseek.v3.2")], []),
    }
    models = bedrock.list_models(
        "AKIA",
        SECRET,
        regions=["us-east-1", "us-west-2"],
        client_factory=lambda region, *_a: clients[region],
    )
    assert len(models) == 1
    assert models[0].region == "us-east-1"


def test_list_models_prices_from_the_book_and_leaves_the_rest_priceless() -> None:
    """Exact price matches land on the row; unmatched models stay price-less."""
    book = bedrock.BedrockPriceBook(
        standard={("v32", "input"): 0.0006, ("v32", "output"): 0.0018},
        cross_region={},
    )
    summaries = [_summary("deepseek.v3.2", modelName="v32"), _summary("qwen.q3")]
    models = {
        m.slug: m
        for m in bedrock.list_models(
            "AKIA",
            SECRET,
            regions=["us-east-1"],
            price_book=book,
            client_factory=lambda *_a: _FakeCatalogClient(summaries, []),
        )
    }
    priced = models["bedrock-deepseek.v3.2"].price
    assert priced is not None
    assert priced.input_micro_usd_per_million == 600_000
    assert priced.output_micro_usd_per_million == 1_800_000
    assert priced.pricing_source == "aws-price-list"
    assert models["bedrock-qwen.q3"].price is None


def test_price_book_drops_ambiguous_rates_and_separates_lanes() -> None:
    """Conflicting rates under one key are dropped; cross-region is its own lane."""
    offer = {
        "products": {
            "SKU-IN": _product("USE1-NovaPro-input-tokens", "Input tokens", "Nova Pro"),
            "SKU-OUT": _product("USE1-NovaPro-output-tokens", "Output tokens", "Nova Pro"),
            "SKU-IN-DUP": _product("USE1-NovaPro-fresh-input-tokens", "Input tokens", "Nova Pro"),
            "SKU-CR-IN": _product(
                "USE1-Claude-input-tokens-cross-region", "Input tokens", "Claude X"
            ),
            "SKU-CR-OUT": _product(
                "USE1-Claude-output-tokens-cross-region", "Output tokens", "Claude X"
            ),
        },
        "terms": {
            "OnDemand": {
                "SKU-IN": _term("SKU-IN", "0.0008"),
                "SKU-OUT": _term("SKU-OUT", "0.0032"),
                "SKU-IN-DUP": _term("SKU-IN-DUP", "0.0004"),
                "SKU-CR-IN": _term("SKU-CR-IN", "0.003"),
                "SKU-CR-OUT": _term("SKU-CR-OUT", "0.015"),
            }
        },
    }
    book = bedrock.fetch_price_book(regions=["us-east-1"], transport=_price_transport(offer))
    # Nova Pro's input rate is ambiguous (0.0008 vs 0.0004) so it is dropped.
    assert book.lookup("amazon.nova-pro", "Nova Pro", cross_region=False) is None
    # Claude X resolves only in the cross-region lane.
    assert book.lookup("anthropic.claude-x", "Claude X", cross_region=False) is None
    cross = book.lookup("anthropic.claude-x", "Claude X", cross_region=True)
    assert cross is not None
    assert cross.input_micro_usd_per_million == 3_000_000


def _product(usagetype: str, inference_type: str, model: str) -> dict[str, Any]:
    return {"attributes": {"usagetype": usagetype, "inferenceType": inference_type, "model": model}}


def _term(sku: str, usd: str) -> dict[str, Any]:
    return {f"{sku}.T": {"priceDimensions": {f"{sku}.T.D": {"pricePerUnit": {"USD": usd}}}}}


def _price_transport(offer: dict[str, Any]) -> httpx.MockTransport:
    """Serve the region index and one region's offer file over the bulk API."""
    offer_path = "/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("region_index.json"):
            return httpx.Response(
                200, json={"regions": {"us-east-1": {"currentVersionUrl": offer_path}}}
            )
        return httpx.Response(200, json=offer)

    return httpx.MockTransport(handler)
