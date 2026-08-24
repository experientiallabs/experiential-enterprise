# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the admin recommended-models read/replace routes."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.conftest import OPERATOR_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient

_ADMIN = {"X-Explabs-Actor-Id": OPERATOR_ID}


def _seed_catalog(supabase: FakeSupabaseClient) -> None:
    supabase.tables["models"] = [
        {
            "id": "model-ox",
            "slug": "ox-alpha",
            "display_name": "Ox Alpha",
            "owning_org_id": None,
            "preferred_rank": 0,
        },
        {
            "id": "model-fable",
            "slug": "claude-fable-5",
            "display_name": "Claude Fable 5",
            "owning_org_id": None,
            "preferred_rank": 1,
        },
        {
            "id": "model-qwen",
            "slug": "qwen3.8-27b",
            "display_name": "Qwen3.8 27B",
            "owning_org_id": None,
            "preferred_rank": None,
        },
        # An org-owned model must never join (or leak from) the public band,
        # even when its slug shadows nothing public.
        {
            "id": "model-org",
            "slug": "org-custom",
            "display_name": "Org Custom",
            "owning_org_id": "org-1",
            "preferred_rank": 0,
        },
    ]


def test_list_requires_platform_admin(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A non-admin actor gets the standard not-found; an admin gets the band."""
    _seed_catalog(supabase)
    assert api.get("/api/admin/recommended-models").status_code == 404
    admin = api.get("/api/admin/recommended-models", headers=_ADMIN)
    assert admin.status_code == 200
    assert admin.json() == {
        "models": [
            {"slug": "ox-alpha", "display_name": "Ox Alpha", "preferred_rank": 0},
            {"slug": "claude-fable-5", "display_name": "Claude Fable 5", "preferred_rank": 1},
        ]
    }


def test_replace_assigns_ranks_in_list_order(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """PUT sets ranks 0..N-1 in body order and unpins every other public model."""
    _seed_catalog(supabase)
    response = api.put(
        "/api/admin/recommended-models",
        json={"slugs": ["qwen3.8-27b", "ox-alpha"]},
        headers=_ADMIN,
    )
    assert response.status_code == 200
    assert response.json() == {
        "models": [
            {"slug": "qwen3.8-27b", "display_name": "Qwen3.8 27B", "preferred_rank": 0},
            {"slug": "ox-alpha", "display_name": "Ox Alpha", "preferred_rank": 1},
        ]
    }
    ranks = {row["slug"]: row["preferred_rank"] for row in supabase.tables["models"]}
    assert ranks == {
        "qwen3.8-27b": 0,
        "ox-alpha": 1,
        "claude-fable-5": None,
        # The org-owned row is outside the public band and untouched.
        "org-custom": 0,
    }
    assert supabase.executed_rpcs == ["recommended_models_apply"]


def test_replace_requires_platform_admin(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A non-admin write gets the standard not-found without persisting."""
    _seed_catalog(supabase)
    response = api.put("/api/admin/recommended-models", json={"slugs": ["qwen3.8-27b"]})
    assert response.status_code == 404
    ranks = {row["slug"]: row["preferred_rank"] for row in supabase.tables["models"]}
    assert ranks["ox-alpha"] == 0
    assert ranks["qwen3.8-27b"] is None


def test_replace_unknown_slug_is_400_naming_it(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A slug with no public catalog model is a bad request naming it.

    An org-owned slug counts as unknown: only the public namespace is
    eligible. Nothing is applied — the RPC refuses before any write.
    """
    _seed_catalog(supabase)
    response = api.put(
        "/api/admin/recommended-models",
        json={"slugs": ["ox-alpha", "no-such-model", "org-custom"]},
        headers=_ADMIN,
    )
    assert response.status_code == 400
    assert "no-such-model, org-custom" in response.json()["error"]
    ranks = {row["slug"]: row["preferred_rank"] for row in supabase.tables["models"]}
    assert ranks["ox-alpha"] == 0
    assert ranks["claude-fable-5"] == 1


def test_replace_empty_list_is_422(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """An empty set is refused at the schema boundary.

    An all-unpinned catalog would read as a fresh database to the seed guard
    and be silently restored to the defaults on the next re-seed.
    """
    _seed_catalog(supabase)
    response = api.put("/api/admin/recommended-models", json={"slugs": []}, headers=_ADMIN)
    assert response.status_code == 422
    assert supabase.executed_rpcs == []


def test_replace_blank_slug_is_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A blank entry is refused before the store is touched."""
    _seed_catalog(supabase)
    response = api.put(
        "/api/admin/recommended-models",
        json={"slugs": ["ox-alpha", "  "]},
        headers=_ADMIN,
    )
    assert response.status_code == 400
    assert supabase.executed_rpcs == []


def test_replace_duplicate_slugs_is_400_naming_them(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A repeated slug has no deterministic rank, so the write is refused."""
    _seed_catalog(supabase)
    response = api.put(
        "/api/admin/recommended-models",
        json={"slugs": ["ox-alpha", "qwen3.8-27b", "ox-alpha"]},
        headers=_ADMIN,
    )
    assert response.status_code == 400
    assert "ox-alpha" in response.json()["error"]
    assert supabase.executed_rpcs == []
