# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the recommended-models store over the fake Supabase client."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.recommended_models_store import (
    RecommendedModelsStore,
    RecommendedModelUnknownError,
)


def _seeded_client() -> FakeSupabaseClient:
    client = FakeSupabaseClient()
    client.tables["models"] = [
        {
            "id": "model-b",
            "slug": "beta",
            "display_name": "Beta",
            "owning_org_id": None,
            "preferred_rank": 1,
        },
        {
            "id": "model-a",
            "slug": "alpha",
            "display_name": "Alpha",
            "owning_org_id": None,
            "preferred_rank": 0,
        },
        {
            "id": "model-c",
            "slug": "gamma",
            "display_name": "Gamma",
            "owning_org_id": None,
            "preferred_rank": None,
        },
        # Org-owned rows never appear in (or join) the public band.
        {
            "id": "model-org",
            "slug": "org-model",
            "display_name": "Org Model",
            "owning_org_id": "org-1",
            "preferred_rank": 0,
        },
    ]
    return client


def test_list_recommended_orders_public_ranked_models() -> None:
    """The read is rank-ascending over public models only."""
    store = RecommendedModelsStore(_seeded_client())
    assert [model.api_view() for model in store.list_recommended()] == [
        {"slug": "alpha", "display_name": "Alpha", "preferred_rank": 0},
        {"slug": "beta", "display_name": "Beta", "preferred_rank": 1},
    ]


def test_replace_swaps_the_whole_band() -> None:
    """The apply assigns list-order ranks and unpins every other public model."""
    client = _seeded_client()
    store = RecommendedModelsStore(client)
    applied = store.replace(("gamma", "alpha"))
    assert [model.api_view() for model in applied] == [
        {"slug": "gamma", "display_name": "Gamma", "preferred_rank": 0},
        {"slug": "alpha", "display_name": "Alpha", "preferred_rank": 1},
    ]
    ranks = {row["slug"]: row["preferred_rank"] for row in client.tables["models"]}
    assert ranks == {"gamma": 0, "alpha": 1, "beta": None, "org-model": 0}
    # The store's read reflects the new band without a separate refresh.
    assert [model.slug for model in store.list_recommended()] == ["gamma", "alpha"]


def test_replace_unknown_slug_raises_typed_error_naming_it() -> None:
    """The RPC's P0002 maps to the typed unknown-slug error, nothing applied."""
    client = _seeded_client()
    store = RecommendedModelsStore(client)
    with pytest.raises(RecommendedModelUnknownError, match="nope"):
        store.replace(("alpha", "nope"))
    ranks = {row["slug"]: row["preferred_rank"] for row in client.tables["models"]}
    assert ranks["alpha"] == 0
    assert ranks["beta"] == 1
