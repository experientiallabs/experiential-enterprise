# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the scoped-promotions admin store."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.model_promotion_store import (
    ModelPromotionModelUnknownError,
    ModelPromotionNotFoundError,
    ModelPromotionScopeError,
    ModelPromotionStore,
)


def _client() -> FakeSupabaseClient:
    client = FakeSupabaseClient()
    client.tables["models"] = [
        {"id": "model-public", "slug": "qwen3.8-27b", "owning_org_id": None},
        # A same-slug org-owned model must NOT be picked as a promo member.
        {"id": "model-org", "slug": "qwen3.8-27b", "owning_org_id": "org-1"},
        {"id": "model-luna", "slug": "gpt-5.6-luna", "owning_org_id": None},
        {"id": "model-sol", "slug": "gpt-5.6-sol", "owning_org_id": None},
    ]
    client.tables["model_promotions"] = []
    client.tables["model_promotion_models"] = []
    return client


def _create_free_tier(store: ModelPromotionStore) -> str:
    """Seed one single-model free-tier promotion; returns its id."""
    return store.create(
        label="qwen free tier",
        model_slugs=("qwen3.8-27b",),
        family_keys=(),
        providers=(),
        per_org_cap_micro_usd=10_000_000,
        discount_cap_micro_usd=0,
        cap_scope="lifetime",
        percent_off=0,
    ).id


def test_create_resolves_public_models_and_persists_terms() -> None:
    """Creating a promotion binds PUBLIC models and stores both caps."""
    client = _client()
    store = ModelPromotionStore(client)
    promotion = store.create(
        label="GPT on Experiential Cloud",
        model_slugs=("gpt-5.6-luna", "gpt-5.6-sol"),
        family_keys=("openai",),
        providers=("experiential_cloud",),
        audience_labels=("yc",),
        per_org_cap_micro_usd=0,
        discount_cap_micro_usd=50_000_000_000,
        cap_scope="lifetime",
        percent_off=50,
        display_order=3,
    )
    assert promotion.model_slugs == ("gpt-5.6-luna", "gpt-5.6-sol")
    assert promotion.providers == ("experiential_cloud",)
    assert promotion.family_keys == ("openai",)
    assert promotion.audience_labels == ("yc",)
    assert promotion.discount_cap_micro_usd == 50_000_000_000
    assert promotion.percent_off == 50
    members = client.tables["model_promotion_models"]
    assert {(row["slug"], row["model_id"]) for row in members} == {
        ("gpt-5.6-luna", "model-luna"),
        ("gpt-5.6-sol", "model-sol"),
    }


def test_create_lane_scope_needs_no_models() -> None:
    """A providers-only promotion is valid and covers all models."""
    store = ModelPromotionStore(_client())
    promotion = store.create(
        label="everything via EC",
        model_slugs=(),
        family_keys=(),
        providers=("experiential_cloud",),
        per_org_cap_micro_usd=0,
        discount_cap_micro_usd=0,
        cap_scope="lifetime",
        percent_off=10,
    )
    assert promotion.model_slugs == ()


def test_create_rejects_empty_scope_unknown_provider_and_bad_terms() -> None:
    """Vocabulary and scope violations fail before touching the database."""
    store = ModelPromotionStore(_client())

    def create(
        *,
        label: str = "x",
        model_slugs: tuple[str, ...] = ("qwen3.8-27b",),
        providers: tuple[str, ...] = (),
        discount_cap_micro_usd: int = 0,
        cap_scope: str = "lifetime",
        percent_off: float = 0,
    ) -> None:
        store.create(
            label=label,
            model_slugs=model_slugs,
            family_keys=(),
            providers=providers,
            per_org_cap_micro_usd=0,
            discount_cap_micro_usd=discount_cap_micro_usd,
            cap_scope=cap_scope,
            percent_off=percent_off,
        )

    with pytest.raises(ModelPromotionScopeError):
        create(model_slugs=(), providers=())
    with pytest.raises(ValueError, match="providers"):
        create(providers=("carrier-pigeon",))
    with pytest.raises(ValueError, match="cap_scope"):
        create(cap_scope="weekly")
    with pytest.raises(ValueError, match="percent_off"):
        create(percent_off=150)
    with pytest.raises(ValueError, match="discount_cap"):
        create(discount_cap_micro_usd=-1)
    with pytest.raises(ValueError, match="label"):
        create(label="  ")


def test_create_rejects_bad_audience_label_key() -> None:
    """An audience key outside the slug shape fails before any write."""
    store = ModelPromotionStore(_client())
    with pytest.raises(ValueError, match="audience"):
        store.create(
            label="yc only",
            model_slugs=("qwen3.8-27b",),
            family_keys=(),
            providers=(),
            audience_labels=("Not A Slug",),
            per_org_cap_micro_usd=0,
            discount_cap_micro_usd=0,
            cap_scope="lifetime",
            percent_off=50,
        )


def test_create_unknown_slug_names_it() -> None:
    """Unresolvable slugs are rejected, naming every offender."""
    store = ModelPromotionStore(_client())
    with pytest.raises(ModelPromotionModelUnknownError, match="not-a-model"):
        store.create(
            label="bad",
            model_slugs=("qwen3.8-27b", "not-a-model"),
            family_keys=(),
            providers=(),
            per_org_cap_micro_usd=0,
            discount_cap_micro_usd=0,
            cap_scope="lifetime",
            percent_off=50,
        )


def test_list_returns_promotions_with_membership() -> None:
    """List returns every promotion with its sorted member slugs."""
    client = _client()
    store = ModelPromotionStore(client)
    _create_free_tier(store)
    store.create(
        label="gpt promo",
        model_slugs=("gpt-5.6-sol", "gpt-5.6-luna"),
        family_keys=("openai",),
        providers=(),
        per_org_cap_micro_usd=0,
        discount_cap_micro_usd=0,
        cap_scope="lifetime",
        percent_off=50,
    )
    by_label = {promotion.label: promotion for promotion in store.list_all()}
    assert by_label["qwen free tier"].model_slugs == ("qwen3.8-27b",)
    assert by_label["gpt promo"].model_slugs == ("gpt-5.6-luna", "gpt-5.6-sol")


def test_update_replaces_terms_and_membership() -> None:
    """Update rewrites the terms and makes membership exactly the new set."""
    client = _client()
    store = ModelPromotionStore(client)
    promotion_id = _create_free_tier(store)
    updated = store.update(
        promotion_id,
        label="qwen + luna",
        model_slugs=("qwen3.8-27b", "gpt-5.6-luna"),
        family_keys=(),
        providers=("experiential_cloud",),
        audience_labels=("yc",),
        funding_scope="byok",
        per_org_cap_micro_usd=0,
        discount_cap_micro_usd=1_000_000,
        cap_scope="recurring",
        percent_off=40,
        active=False,
        display_order=9,
    )
    assert updated.model_slugs == ("gpt-5.6-luna", "qwen3.8-27b")
    assert updated.audience_labels == ("yc",)
    assert updated.funding_scope == "byok"
    assert updated.discount_cap_micro_usd == 1_000_000
    assert updated.cap_scope == "recurring"
    assert updated.active is False
    members = client.tables["model_promotion_models"]
    assert {row["slug"] for row in members} == {"qwen3.8-27b", "gpt-5.6-luna"}


def test_update_missing_promotion_raises() -> None:
    """Editing an unknown id is a not-found."""
    store = ModelPromotionStore(_client())
    with pytest.raises(ModelPromotionNotFoundError):
        store.update(
            "no-such-id",
            label="x",
            model_slugs=("qwen3.8-27b",),
            family_keys=(),
            providers=(),
            audience_labels=(),
            funding_scope="platform_funded",
            per_org_cap_micro_usd=0,
            discount_cap_micro_usd=0,
            cap_scope="lifetime",
            percent_off=0,
            active=True,
            display_order=0,
        )


def test_delete_removes_and_missing_raises() -> None:
    """Delete removes the promotion; deleting a missing one is a not-found."""
    client = _client()
    store = ModelPromotionStore(client)
    promotion_id = _create_free_tier(store)
    store.delete(promotion_id)
    assert store.list_all() == []
    with pytest.raises(ModelPromotionNotFoundError):
        store.delete(promotion_id)


def test_create_defaults_funding_scope_to_platform() -> None:
    """Omitting funding_scope keeps the prior platform-funded-only behavior."""
    store = ModelPromotionStore(_client())
    promotion = store.get(_create_free_tier(store))
    assert promotion.funding_scope == "platform_funded"


def test_create_rejects_unknown_funding_scope() -> None:
    """A funding_scope outside the vocabulary fails before any write."""
    store = ModelPromotionStore(_client())
    with pytest.raises(ValueError, match="funding_scope"):
        store.create(
            label="bad scope",
            model_slugs=("qwen3.8-27b",),
            family_keys=(),
            providers=(),
            funding_scope="free_lunch",
            per_org_cap_micro_usd=0,
            discount_cap_micro_usd=0,
            cap_scope="lifetime",
            percent_off=0,
        )
