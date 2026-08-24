# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the admin scoped-promotions CRUD routes."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.conftest import OPERATOR_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient

_ADMIN = {"X-Explabs-Actor-Id": OPERATOR_ID}

_GPT_BODY = {
    "label": "GPT on Experiential Cloud",
    "model_slugs": ["gpt-5.6-luna"],
    "family_keys": ["openai"],
    "providers": ["experiential_cloud"],
    "per_org_cap_micro_usd": 0,
    "discount_cap_micro_usd": 50_000_000_000,
    "cap_scope": "lifetime",
    "percent_off": 50,
    "display_order": 3,
}


def _seed_catalog(supabase: FakeSupabaseClient) -> None:
    supabase.tables["models"] = [
        {"id": "model-qwen", "slug": "qwen3.8-27b", "owning_org_id": None},
        {"id": "model-luna", "slug": "gpt-5.6-luna", "owning_org_id": None},
    ]
    supabase.tables["model_promotions"] = []
    supabase.tables["model_promotion_models"] = []


def test_list_requires_platform_admin(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A non-admin actor gets the standard not-found; an admin gets the list."""
    _seed_catalog(supabase)
    assert api.get("/api/admin/model-promotions").status_code == 404
    admin = api.get("/api/admin/model-promotions", headers=_ADMIN)
    assert admin.status_code == 200
    assert admin.json() == {"promotions": []}


def test_create_scoped_promotion(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Creating persists label, both caps, and the model + lane scope."""
    _seed_catalog(supabase)
    response = api.post("/api/admin/model-promotions", json=_GPT_BODY, headers=_ADMIN)
    assert response.status_code == 201
    body = response.json()
    assert body["label"] == "GPT on Experiential Cloud"
    assert body["model_slugs"] == ["gpt-5.6-luna"]
    assert body["providers"] == ["experiential_cloud"]
    assert body["discount_cap_micro_usd"] == 50_000_000_000
    assert body["percent_off"] == 50
    assert "id" in body
    assert supabase.tables["model_promotion_models"][0]["slug"] == "gpt-5.6-luna"


def test_create_round_trips_audience_labels(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The audience label set round-trips through create and back into the view."""
    _seed_catalog(supabase)
    response = api.post(
        "/api/admin/model-promotions",
        json={**_GPT_BODY, "audience_labels": ["yc"]},
        headers=_ADMIN,
    )
    assert response.status_code == 201
    assert response.json()["audience_labels"] == ["yc"]
    stored = supabase.tables["model_promotions"][0]
    assert stored["audience_labels"] == ["yc"]


def test_create_defaults_audience_to_all_accounts(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Omitting audience_labels means the promotion applies to every account."""
    _seed_catalog(supabase)
    response = api.post("/api/admin/model-promotions", json=_GPT_BODY, headers=_ADMIN)
    assert response.status_code == 201
    assert response.json()["audience_labels"] == []


def test_create_bad_audience_key_is_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """An audience key outside the slug shape is a bad request naming it."""
    _seed_catalog(supabase)
    response = api.post(
        "/api/admin/model-promotions",
        json={**_GPT_BODY, "audience_labels": ["Not A Slug"]},
        headers=_ADMIN,
    )
    assert response.status_code == 400
    assert "Not A Slug" in response.json()["error"]
    assert supabase.tables["model_promotions"] == []


def test_create_round_trips_funding_scope(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """funding_scope round-trips through create and back into the view."""
    _seed_catalog(supabase)
    response = api.post(
        "/api/admin/model-promotions",
        json={**_GPT_BODY, "funding_scope": "platform_funded"},
        headers=_ADMIN,
    )
    assert response.status_code == 201
    assert response.json()["funding_scope"] == "platform_funded"
    assert supabase.tables["model_promotions"][0]["funding_scope"] == "platform_funded"


def test_create_defaults_funding_scope_to_platform(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Omitting funding_scope keeps the prior platform-funded-only behavior."""
    _seed_catalog(supabase)
    response = api.post("/api/admin/model-promotions", json=_GPT_BODY, headers=_ADMIN)
    assert response.status_code == 201
    assert response.json()["funding_scope"] == "platform_funded"


def test_create_bad_funding_scope_is_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A funding_scope outside the vocabulary is a bad request, nothing persisted."""
    _seed_catalog(supabase)
    response = api.post(
        "/api/admin/model-promotions",
        json={**_GPT_BODY, "funding_scope": "free_lunch"},
        headers=_ADMIN,
    )
    assert response.status_code == 400
    assert "funding_scope" in response.json()["error"]
    assert supabase.tables["model_promotions"] == []


def test_create_unknown_slug_is_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A slug with no public catalog model is a bad request naming it."""
    _seed_catalog(supabase)
    response = api.post(
        "/api/admin/model-promotions",
        json={**_GPT_BODY, "model_slugs": ["no-such-model"]},
        headers=_ADMIN,
    )
    assert response.status_code == 400
    assert "no-such-model" in response.json()["error"]


def test_create_empty_scope_is_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A promotion naming neither models nor providers is refused."""
    _seed_catalog(supabase)
    response = api.post(
        "/api/admin/model-promotions",
        json={**_GPT_BODY, "model_slugs": [], "providers": []},
        headers=_ADMIN,
    )
    assert response.status_code == 400
    assert "scope" in response.json()["error"]


def test_create_unknown_provider_is_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A lane outside the catalog provider vocabulary is refused."""
    _seed_catalog(supabase)
    response = api.post(
        "/api/admin/model-promotions",
        json={**_GPT_BODY, "providers": ["carrier-pigeon"]},
        headers=_ADMIN,
    )
    assert response.status_code == 400
    assert "carrier-pigeon" in response.json()["error"]


def test_create_requires_platform_admin(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A non-admin write gets the standard not-found without persisting."""
    _seed_catalog(supabase)
    response = api.post("/api/admin/model-promotions", json=_GPT_BODY)
    assert response.status_code == 404
    assert supabase.tables["model_promotions"] == []


def test_update_replaces_terms_and_scope(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """PUT rewrites the full resource, membership included."""
    _seed_catalog(supabase)
    created = api.post("/api/admin/model-promotions", json=_GPT_BODY, headers=_ADMIN).json()
    response = api.put(
        f"/api/admin/model-promotions/{created['id']}",
        json={
            **_GPT_BODY,
            "model_slugs": ["qwen3.8-27b"],
            "percent_off": 25,
            "active": False,
        },
        headers=_ADMIN,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["model_slugs"] == ["qwen3.8-27b"]
    assert body["percent_off"] == 25
    assert body["active"] is False
    assert {row["slug"] for row in supabase.tables["model_promotion_models"]} == {"qwen3.8-27b"}


def test_update_missing_is_404(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Editing an unknown (but well-formed) promotion id is a not-found."""
    _seed_catalog(supabase)
    response = api.put(
        "/api/admin/model-promotions/00000000-0000-0000-0000-0000000000aa",
        json=_GPT_BODY,
        headers=_ADMIN,
    )
    assert response.status_code == 404


def test_non_uuid_id_is_404_not_500(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A non-UUID path id 404s at the boundary instead of reaching Postgres.

    The store filters the uuid primary key; an unvalidated string would
    surface as an invalid-uuid database error (500). v1 keyed these routes on
    slugs, so stale callers may still send one.
    """
    _seed_catalog(supabase)
    put = api.put("/api/admin/model-promotions/qwen3.8-27b", json=_GPT_BODY, headers=_ADMIN)
    assert put.status_code == 404
    delete = api.delete("/api/admin/model-promotions/qwen3.8-27b", headers=_ADMIN)
    assert delete.status_code == 404


def test_delete_removes_promotion(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """DELETE removes the row; a second delete is a not-found."""
    _seed_catalog(supabase)
    created = api.post("/api/admin/model-promotions", json=_GPT_BODY, headers=_ADMIN).json()
    response = api.delete(f"/api/admin/model-promotions/{created['id']}", headers=_ADMIN)
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert supabase.tables["model_promotions"] == []
    again = api.delete(f"/api/admin/model-promotions/{created['id']}", headers=_ADMIN)
    assert again.status_code == 404
