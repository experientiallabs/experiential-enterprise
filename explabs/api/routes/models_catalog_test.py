# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for the gateway models management API.

These run against the fake Supabase client, covering HTTP behavior: viewer
visibility, filters and sorting, write validation, and idempotent replays.
Database-enforced behavior (tenancy triggers, nulls-not-distinct conflicts)
is covered by the pgTAP suite plus the integration-marked walk in
``models_catalog_live_test.py``; the error translation for those rejections
is unit-tested here.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import cast

import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError as PostgrestAPIError

from explabs.api.conftest import (
    ACTOR_ID,
    ORG_ID,
    OTHER_ORG_ID,
    OUTSIDER_ID,
    SUPERADMIN_KEY_SECRET,
    TEST_API_KEY,
)
from explabs.api.routes import ApiError
from explabs.api.routes.models_catalog import (
    _resolve_write_org,
    _translated_write_error,
)
from explabs.api.tenancy import RequestActor
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import JsonObject

OPERATOR_ID = "user-platform-admin"

KIMI_ID = "model-kimi"
GPT_ID = "model-gpt"
CHEAP_ID = "model-cheap"
HIDDEN_ID = "model-hidden"
ORG1_CUSTOM_ID = "model-org1-custom"
ORG1_SHADOW_ID = "model-org1-shadow"
ORG2_PRIVATE_ID = "model-org2-private"

KIMI_DEPLOYMENT_ID = "deployment-kimi-openrouter"
GPT_DEPLOYMENT_ID = "deployment-gpt-openai"
CHEAP_DEPLOYMENT_ID = "deployment-cheap-openrouter"
ORG1_VARIANT_ID = "deployment-org1-kimi-local"
ORG1_CUSTOM_DEPLOYMENT_ID = "deployment-org1-custom-local"
ORG2_DEPLOYMENT_ID = "deployment-org2-local"

ORG1_CONNECTION_ID = "connection-org1-openai"
ORG2_CONNECTION_ID = "connection-org2-openai"

_LOCAL_BASE_URL = "http://gpu-proxy.internal:8000/v1"


def _model_row(
    *,
    model_id: str,
    slug: str,
    owning_org_id: str | None = None,
    preferred_rank: int | None = None,
    status: str = "active",
    category: str | None = None,
    context_window: int | None = None,
    release_date: str | None = None,
    input_modalities: list[str] | None = None,
    supported_params: JsonObject | None = None,
    created_at: str = "2026-08-01T00:00:00+00:00",
    huggingface_url: str | None = None,
    release_url: str | None = None,
) -> JsonObject:
    """Build one seeded ``models`` row with the schema's column set."""
    return {
        "id": model_id,
        "slug": slug,
        "huggingface_url": huggingface_url,
        "release_url": release_url,
        "display_name": slug.replace("-", " ").title(),
        "description": None,
        "release_date": release_date,
        "context_window": context_window,
        "max_output_tokens": None,
        "input_modalities": input_modalities or ["text"],
        "output_modalities": ["text"],
        "supported_params": supported_params or {},
        "category": category,
        "tags": [],
        "owning_org_id": owning_org_id,
        "preferred_rank": preferred_rank,
        "status": status,
        "created_at": created_at,
        "updated_at": created_at,
    }


def _deployment_row(
    *,
    deployment_id: str,
    model_id: str,
    provider: str,
    provider_model_id: str,
    owning_org_id: str | None = None,
    base_url: str | None = None,
    input_price: int | None = None,
    throughput_tps: float | None = None,
    created_at: str = "2026-08-01T00:00:00+00:00",
    billing_source: str = "customer_managed",
) -> JsonObject:
    """Build one seeded ``model_providers`` row with the schema's column set."""
    return {
        "id": deployment_id,
        "model_id": model_id,
        "provider": provider,
        "provider_model_id": provider_model_id,
        "base_url": base_url,
        "region": None,
        "api_version": None,
        "owning_org_id": owning_org_id,
        "provider_connection_id": None,
        "billing_source": billing_source,
        "input_micro_usd_per_million": input_price,
        "cached_input_micro_usd_per_million": None,
        "output_micro_usd_per_million": None,
        "reasoning_micro_usd_per_million": None,
        "pricing_source": None,
        "pricing_effective_at": None,
        "capabilities": {},
        "uptime_30d": None,
        "throughput_tps": throughput_tps,
        "latency_p50_ms": None,
        "stats_source": None,
        "status": "active",
        "created_at": created_at,
        "updated_at": created_at,
    }


@pytest.fixture
def catalog(supabase: FakeSupabaseClient) -> FakeSupabaseClient:
    """Seed the three catalog tables on top of the shared org fixture."""
    supabase.tables["models"] = [
        _model_row(
            model_id=KIMI_ID,
            slug="kimi-k2.6",
            preferred_rank=1,
            context_window=262144,
            release_date="2026-01-15",
            input_modalities=["text", "image"],
            supported_params={"tools": True, "temperature": True},
            huggingface_url="https://huggingface.co/moonshotai/Kimi-K2.6",
        ),
        _model_row(
            model_id=GPT_ID,
            slug="gpt-5.5",
            preferred_rank=2,
            context_window=1050000,
            release_date="2026-03-01",
            supported_params={"tools": True, "temperature": False},
            release_url="https://openai.com/index/gpt-5-5/",
        ),
        _model_row(
            model_id=CHEAP_ID,
            slug="cheap-old",
            category="coding",
            context_window=8192,
            release_date="2024-01-01",
            supported_params={"tools": False},
        ),
        _model_row(model_id=HIDDEN_ID, slug="hidden-model", status="hidden"),
        _model_row(
            model_id=ORG1_CUSTOM_ID,
            slug="org1-custom",
            owning_org_id=ORG_ID,
            category="owned",
        ),
        # Org-1's custom model reusing a public slug: the org row shadows the
        # public one for org-1 viewers.
        _model_row(
            model_id=ORG1_SHADOW_ID,
            slug="kimi-k2.6",
            owning_org_id=ORG_ID,
            context_window=4096,
        ),
        _model_row(
            model_id=ORG2_PRIVATE_ID,
            slug="org2-private",
            owning_org_id=OTHER_ORG_ID,
        ),
    ]
    supabase.tables["model_providers"] = [
        _deployment_row(
            deployment_id=KIMI_DEPLOYMENT_ID,
            model_id=KIMI_ID,
            provider="openrouter",
            provider_model_id="moonshotai/kimi-k2.6",
            input_price=541500,
            throughput_tps=90.0,
        ),
        _deployment_row(
            deployment_id=GPT_DEPLOYMENT_ID,
            model_id=GPT_ID,
            provider="openai",
            provider_model_id="gpt-5.5",
            input_price=5000000,
            throughput_tps=140.0,
        ),
        _deployment_row(
            deployment_id=CHEAP_DEPLOYMENT_ID,
            model_id=CHEAP_ID,
            provider="openrouter",
            provider_model_id="cheap/cheap-old",
            input_price=100,
        ),
        _deployment_row(
            deployment_id=ORG1_VARIANT_ID,
            model_id=KIMI_ID,
            provider="local",
            provider_model_id="kimi-k2.6",
            owning_org_id=ORG_ID,
            base_url=_LOCAL_BASE_URL,
        ),
        _deployment_row(
            deployment_id=ORG1_CUSTOM_DEPLOYMENT_ID,
            model_id=ORG1_CUSTOM_ID,
            provider="local",
            provider_model_id="org1-custom",
            owning_org_id=ORG_ID,
            base_url=_LOCAL_BASE_URL,
        ),
        _deployment_row(
            deployment_id=ORG2_DEPLOYMENT_ID,
            model_id=ORG2_PRIVATE_ID,
            provider="local",
            provider_model_id="org2-private",
            owning_org_id=OTHER_ORG_ID,
            base_url=_LOCAL_BASE_URL,
        ),
    ]
    supabase.tables["model_waterfalls"] = [
        {
            "id": "rung-kimi-default-0",
            "model_id": KIMI_ID,
            "org_id": None,
            "position": 0,
            "model_provider_id": KIMI_DEPLOYMENT_ID,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
    ]
    supabase.tables["model_benchmarks"] = [
        # Deliberately seeded out of display order, with one slug the code
        # registry does not know, to prove ordering and the fallback metadata.
        {
            "id": "bench-kimi-arena",
            "model_id": KIMI_ID,
            "benchmark": "lmarena-elo",
            "score": "1421.5",
            "source": "lmarena",
            "source_url": "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
            "retrieved_at": "2026-08-20T00:00:00+00:00",
            "created_at": "2026-08-20T00:00:00+00:00",
            "updated_at": "2026-08-20T00:00:00+00:00",
        },
        {
            "id": "bench-kimi-internal",
            "model_id": KIMI_ID,
            "benchmark": "agentmark-2",
            "score": 61.0,
            "source": "paper",
            "source_url": None,
            "retrieved_at": "2026-08-20T00:00:00+00:00",
            "created_at": "2026-08-20T00:00:00+00:00",
            "updated_at": "2026-08-20T00:00:00+00:00",
        },
        {
            "id": "bench-kimi-mmlu-pro",
            "model_id": KIMI_ID,
            "benchmark": "mmlu-pro",
            "score": 81.3,
            "source": "vendor",
            "source_url": "https://moonshotai.github.io/kimi-k2.6",
            "retrieved_at": "2026-08-20T00:00:00+00:00",
            "created_at": "2026-08-20T00:00:00+00:00",
            "updated_at": "2026-08-20T00:00:00+00:00",
        },
    ]
    supabase.tables["provider_connections"] = [
        {
            "id": ORG1_CONNECTION_ID,
            "org_id": ORG_ID,
            "provider": "openai",
            "created_at": "2026-08-01T00:00:00+00:00",
        },
        {
            "id": ORG2_CONNECTION_ID,
            "org_id": OTHER_ORG_ID,
            "provider": "openai",
            "created_at": "2026-08-01T00:00:00+00:00",
        },
    ]
    return supabase


def _client(catalog: FakeSupabaseClient, actor_id: str | None) -> TestClient:
    """Deployment-key client acting as ``actor_id`` (None = anonymous)."""
    from explabs.api.app import create_app

    headers = {"Authorization": f"Bearer {TEST_API_KEY}"}
    if actor_id is not None:
        headers["X-Explabs-Actor-Id"] = actor_id
    return TestClient(create_app(client=catalog), headers=headers)


@pytest.fixture
def anonymous(catalog: FakeSupabaseClient) -> TestClient:
    """Deployment-key caller with no actor: the signed-out catalog viewer."""
    return _client(catalog, None)


@pytest.fixture
def org1(catalog: FakeSupabaseClient) -> TestClient:
    """Org-1 admin session caller."""
    return _client(catalog, ACTOR_ID)


@pytest.fixture
def outsider(catalog: FakeSupabaseClient) -> TestClient:
    """Session caller with no org memberships."""
    return _client(catalog, OUTSIDER_ID)


@pytest.fixture
def operator(catalog: FakeSupabaseClient) -> TestClient:
    """Platform-admin session caller."""
    return _client(catalog, OPERATOR_ID)


def _slugs(body: JsonObject) -> list[str]:
    """Slugs of a list response, in returned order."""
    # The response is parsed JSON; the shape is asserted by the assertions on
    # each field, so narrow the envelope here only.
    entries = cast("list[JsonObject]", body["models"])
    return [str(cast("JsonObject", entry["model"])["slug"]) for entry in entries]


# ---------------------------------------------------------------------------
# Catalog reads


def test_anonymous_list_shows_public_active_rows_preferred_first(
    anonymous: TestClient,
) -> None:
    """Signed-out viewers see the public catalog; hidden and org rows do not leak."""
    body = anonymous.get("/api/models").json()
    assert _slugs(body) == ["kimi-k2.6", "gpt-5.5", "cheap-old"]
    assert body["total"] == 3
    owners = {entry["model"]["owning_org_id"] for entry in body["models"]}
    assert owners == {None}


def test_list_surfaces_model_release_date(anonymous: TestClient) -> None:
    """The catalog passes each model's release_date straight through."""
    body = anonymous.get("/api/models").json()
    released = {entry["model"]["slug"]: entry["model"]["release_date"] for entry in body["models"]}
    assert released == {
        "kimi-k2.6": "2026-01-15",
        "gpt-5.5": "2026-03-01",
        "cheap-old": "2024-01-01",
    }


def test_list_reports_no_promotions_when_table_empty(anonymous: TestClient) -> None:
    """With no model_promotions rows, the catalog reports an empty promo set."""
    body = anonymous.get("/api/models").json()
    assert body["promotions"] == []


def test_list_surfaces_active_promotions_in_display_order(
    catalog: FakeSupabaseClient, anonymous: TestClient
) -> None:
    """Active promotions surface resolved + ordered; inactive rows drop."""
    catalog.tables["model_promotions"] = [
        {
            "id": "promo-gpt",
            "label": "gpt-5.5 free",
            "providers": [],
            "family_keys": ["openai"],
            "per_org_cap_micro_usd": 20_000_000,
            "discount_cap_micro_usd": 0,
            "percent_off": 0,
            "active": True,
            "display_order": 1,
            "created_at": "2026-08-01T00:00:00+00:00",
        },
        {
            "id": "promo-kimi",
            "label": "kimi half off",
            "providers": ["experiential_cloud"],
            "family_keys": [],
            "per_org_cap_micro_usd": 0,
            "discount_cap_micro_usd": 50_000_000_000,
            "percent_off": 50,
            "active": True,
            "display_order": 0,
            "created_at": "2026-08-01T00:00:00+00:00",
        },
        {
            "id": "promo-inactive",
            "label": "retired",
            "providers": [],
            "family_keys": [],
            "per_org_cap_micro_usd": 1,
            "discount_cap_micro_usd": 0,
            "percent_off": 0,
            "active": False,
            "display_order": 2,
            "created_at": "2026-08-01T00:00:00+00:00",
        },
    ]
    catalog.tables["model_promotion_models"] = [
        {"promotion_id": "promo-gpt", "model_id": GPT_ID, "slug": "gpt-5.5"},
        {"promotion_id": "promo-kimi", "model_id": KIMI_ID, "slug": "kimi-k2.6"},
        {"promotion_id": "promo-inactive", "model_id": CHEAP_ID, "slug": "cheap-old"},
    ]
    body = anonymous.get("/api/models").json()
    assert body["promotions"] == [
        {
            "label": "kimi half off",
            "slugs": ["kimi-k2.6"],
            "display_order": 0,
            "free": False,
            "percent_off": 50,
            "providers": ["experiential_cloud"],
            "family_keys": [],
        },
        {
            "label": "gpt-5.5 free",
            "slugs": ["gpt-5.5"],
            "display_order": 1,
            "free": True,
            "percent_off": 0,
            "providers": [],
            "family_keys": ["openai"],
        },
    ]


def test_list_drops_promotion_for_invisible_model(
    catalog: FakeSupabaseClient, anonymous: TestClient
) -> None:
    """A promo whose scope resolves to no visible model is never surfaced."""
    catalog.tables["model_promotions"] = [
        {
            "id": "promo-hidden",
            "label": "hidden promo",
            "providers": [],
            "family_keys": [],
            "per_org_cap_micro_usd": 1,
            "discount_cap_micro_usd": 0,
            "percent_off": 0,
            "active": True,
            "display_order": 0,
            "created_at": "2026-08-01T00:00:00+00:00",
        },
    ]
    catalog.tables["model_promotion_models"] = [
        {"promotion_id": "promo-hidden", "model_id": HIDDEN_ID, "slug": "hidden-model"},
    ]
    body = anonymous.get("/api/models").json()
    assert body["promotions"] == []


def _yc_scoped_promotions() -> list[JsonObject]:
    """One audience-less promo and one limited to orgs labeled ``yc``."""
    return [
        {
            "id": "promo-open",
            "label": "everyone",
            "providers": [],
            "family_keys": [],
            "audience_labels": [],
            "per_org_cap_micro_usd": 1,
            "discount_cap_micro_usd": 0,
            "percent_off": 0,
            "active": True,
            "display_order": 0,
            "created_at": "2026-08-01T00:00:00+00:00",
        },
        {
            "id": "promo-yc",
            "label": "yc half off",
            "providers": [],
            "family_keys": [],
            "audience_labels": ["yc"],
            "per_org_cap_micro_usd": 0,
            "discount_cap_micro_usd": 50_000_000_000,
            "percent_off": 50,
            "active": True,
            "display_order": 1,
            "created_at": "2026-08-01T00:00:00+00:00",
        },
    ]


def _promo_labels(body: JsonObject) -> list[str]:
    """Labels of the returned promotions, in display order."""
    return [str(cast("JsonObject", promo)["label"]) for promo in cast("list", body["promotions"])]


def test_audience_promotion_hidden_from_anonymous_viewers(
    catalog: FakeSupabaseClient, anonymous: TestClient
) -> None:
    """A label-scoped promo never shows signed out: the discount would not apply."""
    catalog.tables["model_promotions"] = _yc_scoped_promotions()
    catalog.tables["model_promotion_models"] = [
        {"promotion_id": "promo-open", "model_id": GPT_ID, "slug": "gpt-5.5"},
        {"promotion_id": "promo-yc", "model_id": GPT_ID, "slug": "gpt-5.5"},
    ]
    assert _promo_labels(anonymous.get("/api/models").json()) == ["everyone"]


def test_audience_promotion_hidden_from_unlabeled_org(
    catalog: FakeSupabaseClient, org1: TestClient
) -> None:
    """An org without the required label sees only audience-less promotions."""
    catalog.tables["model_promotions"] = _yc_scoped_promotions()
    catalog.tables["model_promotion_models"] = [
        {"promotion_id": "promo-open", "model_id": GPT_ID, "slug": "gpt-5.5"},
        {"promotion_id": "promo-yc", "model_id": GPT_ID, "slug": "gpt-5.5"},
    ]
    catalog.tables["org_labels"] = []
    assert _promo_labels(org1.get("/api/models").json()) == ["everyone"]


def test_audience_promotion_shown_to_labeled_org(
    catalog: FakeSupabaseClient, org1: TestClient
) -> None:
    """An org carrying every required label sees the scoped promotion."""
    catalog.tables["model_promotions"] = _yc_scoped_promotions()
    catalog.tables["model_promotion_models"] = [
        {"promotion_id": "promo-open", "model_id": GPT_ID, "slug": "gpt-5.5"},
        {"promotion_id": "promo-yc", "model_id": GPT_ID, "slug": "gpt-5.5"},
    ]
    catalog.tables["org_labels"] = [
        {"id": "lbl-1", "org_id": ORG_ID, "key": "yc", "created_at": "2026-08-01T00:00:00+00:00"}
    ]
    assert _promo_labels(org1.get("/api/models").json()) == ["everyone", "yc half off"]


def test_audience_narrows_to_the_acting_org(catalog: FakeSupabaseClient, org1: TestClient) -> None:
    """The acting org decides: a qualified OTHER org must not leak the promo.

    Audience enforcement is per-org at charge time, and the workspace acts as
    one org. A viewer whose org-1 carries the label, acting as org-2, is not
    shown the promo (org-2's traffic pays full price); acting as org-1 they
    are; naming an org outside their memberships is refused.
    """
    catalog.tables["organization_members"].append(
        {"org_id": OTHER_ORG_ID, "user_id": ACTOR_ID, "role": "admin"}
    )
    catalog.tables["model_promotions"] = _yc_scoped_promotions()
    catalog.tables["model_promotion_models"] = [
        {"promotion_id": "promo-open", "model_id": GPT_ID, "slug": "gpt-5.5"},
        {"promotion_id": "promo-yc", "model_id": GPT_ID, "slug": "gpt-5.5"},
    ]
    catalog.tables["org_labels"] = [
        {"id": "lbl-1", "org_id": ORG_ID, "key": "yc", "created_at": "2026-08-01T00:00:00+00:00"}
    ]
    acting_unlabeled = org1.get(f"/api/models?audience_org={OTHER_ORG_ID}").json()
    assert _promo_labels(acting_unlabeled) == ["everyone"]
    acting_labeled = org1.get(f"/api/models?audience_org={ORG_ID}").json()
    assert _promo_labels(acting_labeled) == ["everyone", "yc half off"]
    foreign = org1.get("/api/models?audience_org=org-elsewhere")
    assert foreign.status_code == 403


def test_owner_org_read_carries_full_promotion_set(
    catalog: FakeSupabaseClient, org1: TestClient
) -> None:
    """owner=org narrows the MODELS, not the promotions.

    The storefront's signed-in hydrate uses this read to swap in the viewer's
    audience-resolved promotions, so promos over public (non-org) models must
    survive the owner filter.
    """
    catalog.tables["model_promotions"] = _yc_scoped_promotions()
    catalog.tables["model_promotion_models"] = [
        {"promotion_id": "promo-open", "model_id": GPT_ID, "slug": "gpt-5.5"},
        {"promotion_id": "promo-yc", "model_id": GPT_ID, "slug": "gpt-5.5"},
    ]
    catalog.tables["org_labels"] = [
        {"id": "lbl-1", "org_id": ORG_ID, "key": "yc", "created_at": "2026-08-01T00:00:00+00:00"}
    ]
    body = org1.get("/api/models?owner=org").json()
    assert all(
        cast("JsonObject", entry["model"])["owning_org_id"] is not None
        for entry in cast("list[JsonObject]", body["models"])
    )
    assert _promo_labels(body) == ["everyone", "yc half off"]


def test_audience_promotion_shown_to_platform_admin(
    catalog: FakeSupabaseClient, operator: TestClient
) -> None:
    """Operators see every promotion: they manage the deployment's promos."""
    catalog.tables["model_promotions"] = _yc_scoped_promotions()
    catalog.tables["model_promotion_models"] = [
        {"promotion_id": "promo-open", "model_id": GPT_ID, "slug": "gpt-5.5"},
        {"promotion_id": "promo-yc", "model_id": GPT_ID, "slug": "gpt-5.5"},
    ]
    catalog.tables["org_labels"] = []
    assert _promo_labels(operator.get("/api/models").json()) == ["everyone", "yc half off"]


def _completed_event(index: int, *, created_at: str) -> JsonObject:
    """One completed gateway usage event for the gpt-5.5/openai route."""
    return {
        "request_id": f"req-{index}",
        "org_id": ORG_ID,
        "alias": "gpt-5.5",
        "provider": "openai",
        "status": "completed",
        "output_tokens": 120,
        "latency_ms": 1000,
        "created_at": created_at,
    }


def test_detail_overlays_observed_stats_over_the_ledger(
    catalog: FakeSupabaseClient, anonymous: TestClient
) -> None:
    """Enough recent completed events flip a route's stats to observed values."""
    now = datetime.now(tz=UTC).isoformat()
    catalog.tables["gateway_usage_events"] = [
        _completed_event(index, created_at=now) for index in range(20)
    ]
    body = anonymous.get("/api/models/gpt-5.5").json()
    openai_route = next(row for row in body["providers"] if row["provider"] == "openai")
    assert openai_route["stats_source"] == "observed"
    assert openai_route["throughput_tps"] == 120.0
    assert openai_route["uptime_30d"] == 100.0


def test_detail_keeps_seeded_stats_without_enough_events(
    catalog: FakeSupabaseClient, anonymous: TestClient
) -> None:
    """A route below the observed sample floor keeps its seeded throughput."""
    now = datetime.now(tz=UTC).isoformat()
    catalog.tables["gateway_usage_events"] = [
        _completed_event(index, created_at=now) for index in range(5)
    ]
    body = anonymous.get("/api/models/gpt-5.5").json()
    openai_route = next(row for row in body["providers"] if row["provider"] == "openai")
    assert openai_route["stats_source"] is None
    assert openai_route["throughput_tps"] == 140.0


def test_org_viewer_sees_own_models_not_foreign_ones(org1: TestClient) -> None:
    """An org actor additionally sees its own rows, never another tenant's."""
    slugs = _slugs(org1.get("/api/models").json())
    assert "org1-custom" in slugs
    assert "org2-private" not in slugs
    # Both the public and the org's shadowing row list (same slug, two rows).
    assert slugs.count("kimi-k2.6") == 2


def test_owner_org_lists_only_the_viewers_own_rows(org1: TestClient) -> None:
    """owner=org returns just the viewer's org rows: the per-user overlay."""
    body = org1.get("/api/models", params={"owner": "org"}).json()
    assert sorted(_slugs(body)) == ["kimi-k2.6", "org1-custom"]
    owners = {entry["model"]["owning_org_id"] for entry in body["models"]}
    assert owners == {ORG_ID}
    assert body["total"] == 2


def test_owner_org_is_empty_for_anonymous_viewers(anonymous: TestClient) -> None:
    """The shared public base carries no org rows, so a signed-out overlay is empty."""
    body = anonymous.get("/api/models", params={"owner": "org"}).json()
    assert body["models"] == []
    assert body["total"] == 0


def test_org_viewer_sees_own_private_deployments(org1: TestClient) -> None:
    """The org's private variant on a public model lists for the org only."""
    body = org1.get("/api/models/kimi-k2.6/providers", params={"org_id": ORG_ID}).json()
    # org_id pins the namespace to the org's shadow row here, so resolve the
    # public row explicitly via the anonymous assertions below.
    assert body["model_id"] == ORG1_SHADOW_ID


def test_anonymous_detail_hides_private_deployments(anonymous: TestClient) -> None:
    """Anonymous detail resolves the public row and hides org variants."""
    body = anonymous.get("/api/models/kimi-k2.6").json()
    assert body["model"]["id"] == KIMI_ID
    providers = {row["id"] for row in body["providers"]}
    assert providers == {KIMI_DEPLOYMENT_ID}
    assert [rung["model_provider_id"] for rung in body["default_waterfall"]] == [KIMI_DEPLOYMENT_ID]


def test_experiential_cloud_leads_provider_lists_even_when_slower(
    catalog: FakeSupabaseClient, anonymous: TestClient
) -> None:
    """Experiential Cloud is first on list, detail, and /providers.

    A faster OpenRouter house lane is inserted first with an earlier
    created_at so insertion time and throughput both prefer it. Identity
    still wins. The default waterfall stays the persisted OpenRouter-only
    chain — this is display order, not a new route.
    """
    model_id = "model-flash-order"
    openrouter_id = "deployment-flash-openrouter"
    azure_id = "deployment-flash-azure"
    cloud_id = "deployment-flash-cloud"
    catalog.tables["models"].append(
        _model_row(model_id=model_id, slug="deepseek-v4-flash", preferred_rank=9)
    )
    catalog.tables["model_providers"].extend(
        [
            _deployment_row(
                deployment_id=openrouter_id,
                model_id=model_id,
                provider="openrouter",
                provider_model_id="deepseek/deepseek-v4-flash",
                throughput_tps=200.0,
                created_at="2026-08-01T00:00:00+00:00",
                billing_source="host_managed",
            ),
            _deployment_row(
                deployment_id=azure_id,
                model_id=model_id,
                provider="azure_openai",
                provider_model_id="DeepSeek-V4-Flash",
                throughput_tps=150.0,
                created_at="2026-08-02T00:00:00+00:00",
                billing_source="host_managed",
            ),
            _deployment_row(
                deployment_id=cloud_id,
                model_id=model_id,
                provider="experiential_cloud",
                provider_model_id="deepseek-v4-flash",
                throughput_tps=40.0,
                created_at="2026-08-03T00:00:00+00:00",
                billing_source="host_managed",
            ),
        ]
    )
    catalog.tables["model_waterfalls"].append(
        {
            "id": "waterfall-flash-openrouter",
            "model_id": model_id,
            "org_id": None,
            "position": 0,
            "model_provider_id": openrouter_id,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        }
    )
    expected = [cloud_id, openrouter_id, azure_id]
    listed = next(
        entry
        for entry in anonymous.get("/api/models").json()["models"]
        if entry["model"]["slug"] == "deepseek-v4-flash"
    )
    assert [row["id"] for row in listed["providers"]] == expected
    detail = anonymous.get("/api/models/deepseek-v4-flash").json()
    assert [row["id"] for row in detail["providers"]] == expected
    assert [rung["model_provider_id"] for rung in detail["default_waterfall"]] == [openrouter_id]
    providers = anonymous.get("/api/models/deepseek-v4-flash/providers").json()
    assert [row["id"] for row in providers["providers"]] == expected


def test_detail_exposes_supported_params_so_a_caller_knows_how_to_call_it(
    anonymous: TestClient,
) -> None:
    """Model detail publishes the per-model call constraints.

    An agent asking "how do I call this model" reads ``supported_params`` from
    the model detail: a model whose declaration marks ``temperature`` as
    unsupported (a reasoning model that pins its sampling) is answerable here
    instead of only discoverable by triggering a provider rejection.
    """
    body = anonymous.get("/api/models/gpt-5.5").json()
    assert body["model"]["supported_params"] == {"tools": True, "temperature": False}


def test_org_detail_prefers_the_orgs_shadowing_row(org1: TestClient) -> None:
    """An org's custom model shadows the public slug for that org."""
    body = org1.get("/api/models/kimi-k2.6").json()
    assert body["model"]["id"] == ORG1_SHADOW_ID
    assert body["model"]["owning_org_id"] == ORG_ID


def test_unknown_slug_answers_a_self_correcting_404(anonymous: TestClient) -> None:
    """The 404 names the slug and the calls that list or create models."""
    response = anonymous.get("/api/models/no-such-model")
    assert response.status_code == 404
    message = response.json()["error"]
    assert "no-such-model" in message
    assert "GET /api/models" in message
    assert "POST /api/models" in message


def test_hidden_public_model_is_operator_only(anonymous: TestClient, operator: TestClient) -> None:
    """Hidden public rows never render for tenants but stay operable."""
    assert anonymous.get("/api/models/hidden-model").status_code == 404
    assert operator.get("/api/models/hidden-model").status_code == 200


def test_superadmin_key_browses_with_the_operator_view(catalog: FakeSupabaseClient) -> None:
    """An xpladmin_ bearer with no actor header gets the platform-admin view.

    Machine operators send no actor header, so the optional-actor resolver
    must recognize the superadmin request-state stamp; without it the key
    would browse the catalog anonymously and silently miss hidden rows.
    """
    from explabs.api.app import create_app

    client = TestClient(
        create_app(client=catalog),
        headers={"Authorization": f"Bearer {SUPERADMIN_KEY_SECRET}"},
    )
    assert client.get("/api/models/hidden-model").status_code == 200


def test_list_filters(anonymous: TestClient) -> None:
    """Each documented filter narrows the catalog."""
    get = lambda **params: _slugs(anonymous.get("/api/models", params=params).json())  # noqa: E731
    assert get(category="coding") == ["cheap-old"]
    assert get(provider="openai") == ["gpt-5.5"]
    assert get(min_context=1000000) == ["gpt-5.5"]
    assert get(max_input_micro_usd_per_million=600000) == ["kimi-k2.6", "cheap-old"]
    assert get(supports="tools") == ["kimi-k2.6", "gpt-5.5"]
    assert get(modality="image") == ["kimi-k2.6"]


def test_list_sorts(anonymous: TestClient) -> None:
    """Sorts order by the requested key with unknown values last."""
    get = lambda **params: _slugs(anonymous.get("/api/models", params=params).json())  # noqa: E731
    assert get(sort="price") == ["cheap-old", "kimi-k2.6", "gpt-5.5"]
    assert get(sort="price", order="desc") == ["gpt-5.5", "kimi-k2.6", "cheap-old"]
    assert get(sort="age") == ["gpt-5.5", "kimi-k2.6", "cheap-old"]
    assert get(sort="context") == ["gpt-5.5", "kimi-k2.6", "cheap-old"]
    # cheap-old has no throughput stat: last in both directions.
    assert get(sort="throughput") == ["gpt-5.5", "kimi-k2.6", "cheap-old"]
    assert get(sort="throughput", order="asc") == ["kimi-k2.6", "gpt-5.5", "cheap-old"]


def test_list_pagination(anonymous: TestClient) -> None:
    """limit/offset window the sorted list while total reports the full count."""
    body = anonymous.get("/api/models", params={"limit": 1, "offset": 1}).json()
    assert _slugs(body) == ["gpt-5.5"]
    assert body["total"] == 3
    assert body["limit"] == 1
    assert body["offset"] == 1


def test_list_rejects_unknown_filter_values(anonymous: TestClient) -> None:
    """Unknown vocabulary values answer 422 listing the allowed values."""
    response = anonymous.get("/api/models", params={"modality": "smell"})
    assert response.status_code == 422
    assert "text, image, audio, video, pdf" in response.json()["error"]
    response = anonymous.get("/api/models", params={"provider": "acme"})
    assert response.status_code == 422
    assert "openai" in response.json()["error"]


# ---------------------------------------------------------------------------
# Custom model creation


def _custom_model_body(**overrides: object) -> JsonObject:
    """A valid custom-model create body for org-1."""
    body: JsonObject = {
        "org_id": ORG_ID,
        "slug": "acme-router",
        "display_name": "Acme Router",
        "context_window": 32768,
        "providers": [
            {
                "provider": "local",
                "provider_model_id": "acme-router",
                "base_url": "http://acme-serving.internal:8000/v1",
            }
        ],
    }
    body.update(overrides)
    return body


def test_create_custom_model_writes_row_deployment_and_default_chain(
    org1: TestClient, catalog: FakeSupabaseClient
) -> None:
    """The create writes all three tables and answers 201 with the detail."""
    response = org1.post("/api/models", json=_custom_model_body())
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["model"]["slug"] == "acme-router"
    assert body["model"]["owning_org_id"] == ORG_ID
    assert len(body["providers"]) == 1
    assert body["providers"][0]["provider"] == "local"
    assert body["providers"][0]["billing_source"] == "customer_managed"
    assert [rung["position"] for rung in body["default_waterfall"]] == [0]
    model_id = body["model"]["id"]
    chain = [
        row
        for row in catalog.tables["model_waterfalls"]
        if row["model_id"] == model_id and row["org_id"] is None
    ]
    assert len(chain) == 1


def test_create_custom_model_replay_answers_200_without_duplicates(
    org1: TestClient, catalog: FakeSupabaseClient
) -> None:
    """An exact retry converges on the existing rows."""
    assert org1.post("/api/models", json=_custom_model_body()).status_code == 201
    replay = org1.post("/api/models", json=_custom_model_body())
    assert replay.status_code == 200
    rows = [row for row in catalog.tables["models"] if row["slug"] == "acme-router"]
    assert len(rows) == 1
    deployments = [
        row for row in catalog.tables["model_providers"] if row["model_id"] == rows[0]["id"]
    ]
    assert len(deployments) == 1


def test_create_custom_model_conflict_answers_409(org1: TestClient) -> None:
    """The same slug with different attributes is a conflict, not a replay."""
    assert org1.post("/api/models", json=_custom_model_body()).status_code == 201
    conflict = org1.post("/api/models", json=_custom_model_body(display_name="Different Name"))
    assert conflict.status_code == 409
    message = conflict.json()["error"]
    assert "already exists" in message
    assert "GET /api/models/acme-router" in message


def test_create_requires_org_for_session_actors(org1: TestClient) -> None:
    """A session actor must name the organization; the 422 says how."""
    response = org1.post("/api/models", json=_custom_model_body(org_id=None))
    assert response.status_code == 422
    assert "GET /api/orgs" in response.json()["error"]


def test_create_rejects_foreign_orgs(outsider: TestClient) -> None:
    """Non-members get the org's 404, indistinguishable from absence."""
    response = outsider.post("/api/models", json=_custom_model_body())
    assert response.status_code == 404


def test_create_rejects_preferred_rank_for_everyone(org1: TestClient, operator: TestClient) -> None:
    """Ranks are never set at creation, for tenants OR platform admins.

    The recommended band is managed whole-set via PUT
    /api/admin/recommended-models (a per-model rank at creation could race the
    band's atomic clear-and-rank), so the create schema forbids the field.
    """
    response = org1.post("/api/models", json=_custom_model_body(preferred_rank=1))
    assert response.status_code == 422
    assert "preferred_rank" in response.text
    admin_body = _custom_model_body(org_id=None, preferred_rank=3)
    admin_body["providers"] = [{"provider": "openrouter", "provider_model_id": "acme/acme-router"}]
    admin = operator.post("/api/models", json=admin_body)
    assert admin.status_code == 422
    assert "preferred_rank" in admin.text


def test_platform_admin_creates_public_rows_unranked(operator: TestClient) -> None:
    """The data-fill fan-out path: public row via org_id null, never pinned.

    The row lands unranked; only the recommended-models PUT assigns ranks.
    """
    body = _custom_model_body(org_id=None)
    body["providers"] = [{"provider": "openrouter", "provider_model_id": "acme/acme-router"}]
    response = operator.post("/api/models", json=body)
    assert response.status_code == 201, response.text
    assert response.json()["model"]["owning_org_id"] is None
    assert response.json()["model"]["preferred_rank"] is None


def test_create_rejects_digit_first_slugs(org1: TestClient) -> None:
    """Slugs become gateway aliases, which are letter-first."""
    response = org1.post("/api/models", json=_custom_model_body(slug="1acme"))
    assert response.status_code == 422


@pytest.mark.parametrize(
    ("provider", "base_url", "fragment"),
    [
        ("local", None, "requires base_url"),
        ("modal", None, "requires base_url"),
        ("openai", "http://host:1/v1", "drop base_url"),
        ("experiential_cloud", None, "curated collection of models"),
    ],
)
def test_create_base_url_rules(
    org1: TestClient, provider: str, base_url: str | None, fragment: str
) -> None:
    """base_url is required for local/modal and forbidden on fixed-origin rows."""
    body = _custom_model_body()
    body["providers"] = [{"provider": provider, "provider_model_id": "acme", "base_url": base_url}]
    response = org1.post("/api/models", json=body)
    assert response.status_code == 422
    assert fragment in response.json()["error"]


def test_create_rejects_malformed_base_url(org1: TestClient) -> None:
    """The strict endpoint grammar rejects query strings up front."""
    body = _custom_model_body()
    body["providers"] = [
        {
            "provider": "local",
            "provider_model_id": "acme",
            "base_url": "http://host:8000/v1?key=1",
        }
    ]
    assert org1.post("/api/models", json=body).status_code == 422


def test_create_validates_connection_pins(org1: TestClient) -> None:
    """A pin must name the org's own connection with a matching provider."""
    body = _custom_model_body()
    body["providers"] = [
        {
            "provider": "openai",
            "provider_model_id": "acme",
            "provider_connection_id": ORG2_CONNECTION_ID,
        }
    ]
    assert org1.post("/api/models", json=body).status_code == 404
    body["providers"] = [
        {
            "provider": "anthropic",
            "provider_model_id": "acme",
            "provider_connection_id": ORG1_CONNECTION_ID,
        }
    ]
    mismatch = org1.post("/api/models", json=body)
    assert mismatch.status_code == 422
    assert "openai" in mismatch.json()["error"]


# ---------------------------------------------------------------------------
# Adding deployments


def _variant_body(**overrides: object) -> JsonObject:
    """A valid local-variant body for org-1 on a public model."""
    body: JsonObject = {
        "org_id": ORG_ID,
        "provider": "local",
        "provider_model_id": "gpt-5.5",
        "base_url": "http://org1-gpus.internal:9000/v1",
    }
    body.update(overrides)
    return body


def test_add_local_variant_to_public_model(org1: TestClient, catalog: FakeSupabaseClient) -> None:
    """An org adds its private route to a public model."""
    response = org1.post("/api/models/gpt-5.5/providers", json=_variant_body())
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["owning_org_id"] == ORG_ID
    assert body["model_id"] == GPT_ID
    rows = [
        row
        for row in catalog.tables["model_providers"]
        if row["model_id"] == GPT_ID and row["owning_org_id"] == ORG_ID
    ]
    assert len(rows) == 1


def test_add_variant_replay_answers_200(org1: TestClient) -> None:
    """Retrying the identical add converges on the existing deployment."""
    assert org1.post("/api/models/gpt-5.5/providers", json=_variant_body()).status_code == 201
    replay = org1.post("/api/models/gpt-5.5/providers", json=_variant_body())
    assert replay.status_code == 200


def test_add_variant_with_changed_attributes_conflicts(org1: TestClient) -> None:
    """The same route identity with different attributes answers 409."""
    assert org1.post("/api/models/gpt-5.5/providers", json=_variant_body()).status_code == 201
    conflict = org1.post(
        "/api/models/gpt-5.5/providers",
        json=_variant_body(input_micro_usd_per_million=5),
    )
    assert conflict.status_code == 409
    assert "GET /api/models/gpt-5.5/providers" in conflict.json()["error"]


def test_add_variant_to_foreign_private_model_is_404(org1: TestClient) -> None:
    """Another tenant's private model is indistinguishable from absence."""
    response = org1.post("/api/models/org2-private/providers", json=_variant_body())
    assert response.status_code == 404


def test_add_requires_auth(catalog: FakeSupabaseClient) -> None:
    """Writes require an actor; the anonymous read credential cannot write."""
    client = _client(catalog, None)
    response = client.post("/api/models/gpt-5.5/providers", json=_variant_body())
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Waterfalls


def test_get_waterfall_requires_org_context(org1: TestClient) -> None:
    """A session actor names the org whose override to read."""
    assert org1.get("/api/models/gpt-5.5/waterfall").status_code == 422
    body = org1.get("/api/models/gpt-5.5/waterfall", params={"org_id": ORG_ID}).json()
    assert body["org_id"] == ORG_ID
    assert body["override"] is None


def test_shadowed_slug_addresses_the_org_model_for_chain_writes(
    org1: TestClient,
) -> None:
    """An org that shadows a public slug edits its own model's chain.

    Slug resolution matches the gateway's alias shadowing (org row wins, then
    public), so org-1's rungs on the PUBLIC kimi row are unreachable through
    the shadowed slug and answer the deployment 404.
    """
    response = org1.put(
        "/api/models/kimi-k2.6/waterfall",
        json={"org_id": ORG_ID, "model_provider_ids": [KIMI_DEPLOYMENT_ID]},
    )
    assert response.status_code == 404


def test_put_waterfall_lifecycle_on_a_public_model(
    org1: TestClient, catalog: FakeSupabaseClient
) -> None:
    """Set an ordered override, read it back, replay it, then clear it."""
    variant = org1.post("/api/models/gpt-5.5/providers", json=_variant_body()).json()
    put_body = {
        "org_id": ORG_ID,
        "model_provider_ids": [variant["id"], GPT_DEPLOYMENT_ID],
    }
    before = next(row["updated_at"] for row in catalog.tables["models"] if row["id"] == GPT_ID)
    response = org1.put("/api/models/gpt-5.5/waterfall", json=put_body)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["org_id"] == ORG_ID
    assert body["override"] is not None
    assert [rung["model_provider_id"] for rung in body["override"]] == [
        variant["id"],
        GPT_DEPLOYMENT_ID,
    ]
    assert [rung["position"] for rung in body["override"]] == [0, 1]

    read = org1.get("/api/models/gpt-5.5/waterfall", params={"org_id": ORG_ID}).json()
    assert [rung["model_provider_id"] for rung in read["override"]] == [
        variant["id"],
        GPT_DEPLOYMENT_ID,
    ]

    replay = org1.put("/api/models/gpt-5.5/waterfall", json=put_body)
    assert replay.status_code == 200
    rows = [
        row
        for row in catalog.tables["model_waterfalls"]
        if row["model_id"] == GPT_ID and row["org_id"] == ORG_ID
    ]
    assert sorted(row["position"] for row in rows) == [0, 1]

    cleared = org1.put(
        "/api/models/gpt-5.5/waterfall",
        json={"org_id": ORG_ID, "model_provider_ids": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["override"] is None
    remaining = [
        row
        for row in catalog.tables["model_waterfalls"]
        if row["model_id"] == GPT_ID and row["org_id"] == ORG_ID
    ]
    assert remaining == []
    # The clear is a pure delete; the model-row touch keeps the catalog
    # builder's poll aware of it.
    after = next(row["updated_at"] for row in catalog.tables["models"] if row["id"] == GPT_ID)
    assert after != before


def test_put_waterfall_rejects_foreign_and_unknown_deployments(
    org1: TestClient,
) -> None:
    """Foreign-org rungs answer the same 404 as absent ids."""
    response = org1.put(
        "/api/models/gpt-5.5/waterfall",
        json={"org_id": ORG_ID, "model_provider_ids": [ORG2_DEPLOYMENT_ID]},
    )
    assert response.status_code == 404
    assert "GET /api/models/gpt-5.5/providers" in response.json()["error"]
    response = org1.put(
        "/api/models/gpt-5.5/waterfall",
        json={"org_id": ORG_ID, "model_provider_ids": ["no-such-deployment"]},
    )
    assert response.status_code == 404


def test_put_waterfall_rejects_other_models_deployments(org1: TestClient) -> None:
    """A rung may only chain deployments of its own model."""
    response = org1.put(
        "/api/models/gpt-5.5/waterfall",
        json={"org_id": ORG_ID, "model_provider_ids": [KIMI_DEPLOYMENT_ID]},
    )
    assert response.status_code == 404


def test_put_waterfall_rejects_duplicate_rungs(org1: TestClient) -> None:
    """A deployment appears at most once per chain."""
    response = org1.put(
        "/api/models/gpt-5.5/waterfall",
        json={
            "org_id": ORG_ID,
            "model_provider_ids": [GPT_DEPLOYMENT_ID, GPT_DEPLOYMENT_ID],
        },
    )
    assert response.status_code == 422
    assert "de-duplicate" in response.json()["error"]


def test_platform_admin_edits_the_default_chain(
    operator: TestClient, catalog: FakeSupabaseClient
) -> None:
    """org_id null replaces the default chain, public rungs only."""
    response = operator.put(
        "/api/models/gpt-5.5/waterfall",
        json={"org_id": None, "model_provider_ids": [GPT_DEPLOYMENT_ID]},
    )
    assert response.status_code == 200, response.text
    assert [rung["model_provider_id"] for rung in response.json()["default"]] == [GPT_DEPLOYMENT_ID]
    # A tenant's private deployment cannot enter the default chain.
    rejected = operator.put(
        "/api/models/kimi-k2.6/waterfall",
        json={"org_id": None, "model_provider_ids": [ORG1_VARIANT_ID]},
    )
    assert rejected.status_code == 404


# ---------------------------------------------------------------------------
# Customer-key middleware gap (Contract 3 flag)


def test_customer_keys_reach_the_models_catalog(
    catalog: FakeSupabaseClient,
) -> None:
    """xpl_ keys reach the models-management surface once allowlisted.

    integration-P5 added the models routes to ``_CUSTOMER_KEY_ROUTES``, so a
    customer key now passes the middleware and reaches the catalog reads it
    was blocked from before.
    """
    from explabs.api.app import create_app
    from explabs.api.conftest import CUSTOMER_KEY_SECRET

    client = TestClient(
        create_app(client=catalog),
        headers={"Authorization": f"Bearer {CUSTOMER_KEY_SECRET}"},
    )
    assert client.get("/api/models").status_code == 200


# ---------------------------------------------------------------------------
# Benchmarks + release links (detail-only fields)


def test_detail_returns_benchmarks_registry_order_first_with_provenance(
    anonymous: TestClient,
) -> None:
    """Scores come back registry order first, each with its provenance."""
    body = anonymous.get("/api/models/kimi-k2.6").json()
    benchmarks = cast("list[JsonObject]", body["benchmarks"])
    # mmlu-pro precedes lmarena-elo per registry order; the slug the registry
    # does not know sorts after every registered one.
    assert [row["benchmark"] for row in benchmarks] == ["mmlu-pro", "lmarena-elo", "agentmark-2"]
    mmlu_pro = benchmarks[0]
    assert mmlu_pro["display_name"] == "MMLU-Pro"
    assert mmlu_pro["unit"] == "percent"
    assert mmlu_pro["higher_is_better"] is True
    assert mmlu_pro["score"] == 81.3
    assert mmlu_pro["source"] == "vendor"
    assert mmlu_pro["source_url"] == "https://moonshotai.github.io/kimi-k2.6"
    assert mmlu_pro["retrieved_at"] == "2026-08-20T00:00:00+00:00"
    # PostgREST may hand numerics back as strings; the view re-numbers them.
    arena = benchmarks[1]
    assert arena["unit"] == "elo"
    assert arena["score"] == 1421.5


def test_detail_falls_back_to_slug_metadata_for_unregistered_benchmarks(
    anonymous: TestClient,
) -> None:
    """A row the code registry does not know still renders, never drops."""
    body = anonymous.get("/api/models/kimi-k2.6").json()
    unknown = cast("list[JsonObject]", body["benchmarks"])[-1]
    assert unknown["benchmark"] == "agentmark-2"
    assert unknown["display_name"] == "agentmark-2"
    assert unknown["unit"] == "points"
    assert unknown["higher_is_better"] is True
    assert unknown["source_url"] is None


def test_detail_carries_huggingface_and_release_urls(anonymous: TestClient) -> None:
    """Each detail exposes its own link; absent links stay explicit nulls."""
    kimi = anonymous.get("/api/models/kimi-k2.6").json()
    assert kimi["huggingface_url"] == "https://huggingface.co/moonshotai/Kimi-K2.6"
    assert kimi["release_url"] is None
    gpt = anonymous.get("/api/models/gpt-5.5").json()
    assert gpt["huggingface_url"] is None
    assert gpt["release_url"] == "https://openai.com/index/gpt-5-5/"
    cheap = anonymous.get("/api/models/cheap-old").json()
    assert cheap["huggingface_url"] is None
    assert cheap["release_url"] is None
    assert cheap["benchmarks"] == []


def test_list_payload_carries_no_benchmark_fields(anonymous: TestClient) -> None:
    """The full-catalog list stays lean: benchmarks ride the detail only."""
    body = anonymous.get("/api/models").json()
    entry = cast("list[JsonObject]", body["models"])[0]
    assert "benchmarks" not in entry
    model = cast("JsonObject", entry["model"])
    assert "huggingface_url" not in model
    assert "release_url" not in model


# ---------------------------------------------------------------------------
# Unit coverage for the pieces HTTP tests cannot reach on the fake


def test_resolve_write_org_for_key_actors(catalog: FakeSupabaseClient) -> None:
    """A key acts for exactly its org; a mismatch is the org's 404."""
    key_actor = RequestActor(
        user_id=f"api-key:{ORG_ID}",
        is_platform_admin=False,
        api_key_org_id=ORG_ID,
        api_key_id="key-org1",
    )
    assert _resolve_write_org(catalog, key_actor, None) == ORG_ID
    assert _resolve_write_org(catalog, key_actor, ORG_ID) == ORG_ID
    with pytest.raises(ApiError) as excinfo:
        _resolve_write_org(catalog, key_actor, OTHER_ORG_ID)
    assert excinfo.value.status_code == 404


@pytest.mark.parametrize(
    ("code", "expected_status"),
    [("23505", 409), ("23514", 422), ("23503", 422)],
)
def test_translated_write_errors_map_to_clean_4xx(code: str, expected_status: int) -> None:
    """Constraint and trigger rejections become 4xx with the DB's message."""
    error = PostgrestAPIError(
        {"message": "a waterfall rung may reference only public deployments", "code": code}
    )
    translated = _translated_write_error(error, action="test write")
    assert translated.status_code == expected_status
    assert "waterfall rung" in str(translated)


def test_translated_write_error_reraises_server_faults() -> None:
    """Non-constraint database errors stay 500s, not fabricated 4xxs."""
    error = PostgrestAPIError({"message": "connection lost", "code": "57P01"})
    with pytest.raises(PostgrestAPIError):
        _translated_write_error(error, action="test write")
