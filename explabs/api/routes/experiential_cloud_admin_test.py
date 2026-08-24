# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the admin Experiential Cloud lane routes (list/create/update/toggle)."""

from __future__ import annotations

# The TestClient (starlette) returns an httpx2 response, so the helper's
# annotation must name that module's Response, not httpx's.
import httpx2
from fastapi.testclient import TestClient

from explabs.api.conftest import OPERATOR_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient

_ADMIN = {"X-Explabs-Actor-Id": OPERATOR_ID}
_LIST = "/api/admin/experiential-cloud"


def _seed_models(supabase: FakeSupabaseClient) -> None:
    supabase.tables["models"] = [
        {
            "id": "model-deepseek",
            "slug": "deepseek-v4-flash",
            "display_name": "DeepSeek V4 Flash",
            "owning_org_id": None,
        },
        # An org-owned model of the same slug must never be an EC target.
        {
            "id": "model-org",
            "slug": "deepseek-v4-flash",
            "display_name": "Org DeepSeek",
            "owning_org_id": "org-1",
        },
    ]
    supabase.tables.setdefault("model_providers", [])


def _create(api: TestClient, **overrides: object) -> httpx2.Response:
    body: dict[str, object] = {
        "slug": "deepseek-v4-flash",
        "provider_model_id": "deepseek-v4-flash",
        "input_micro_usd_per_million": 42448,
        "cached_input_micro_usd_per_million": 8489,
        "output_micro_usd_per_million": 84896,
    }
    body.update(overrides)
    return api.post(_LIST, json=body, headers=_ADMIN)


# Path routes validate the id as a UUID (a non-UUID would surface as a Postgres
# invalid-uuid 500), so id-addressed tests seed a row with a real UUID rather
# than the fake's synthetic ``model_providers-N`` id.
_EC_ID = "11111111-1111-1111-1111-111111111111"


def _seed_ec_deployment(supabase: FakeSupabaseClient, *, status: str = "disabled") -> str:
    """Insert one complete Experiential Cloud lane row and return its id."""
    supabase.tables.setdefault("model_providers", []).append(
        {
            "id": _EC_ID,
            "model_id": "model-deepseek",
            "provider": "experiential_cloud",
            "provider_model_id": "deepseek-v4-flash",
            "base_url": None,
            "region": None,
            "api_version": None,
            "owning_org_id": None,
            "provider_connection_id": None,
            "billing_source": "host_managed",
            "input_micro_usd_per_million": 42448,
            "cached_input_micro_usd_per_million": 8489,
            "output_micro_usd_per_million": 84896,
            "reasoning_micro_usd_per_million": None,
            "pricing_source": None,
            "pricing_effective_at": None,
            "capabilities": {},
            "uptime_30d": None,
            "throughput_tps": None,
            "latency_p50_ms": None,
            "stats_source": None,
            "status": status,
            "created_at": "2026-08-22T00:00:00+00:00",
            "updated_at": "2026-08-22T00:00:00+00:00",
        }
    )
    return _EC_ID


def test_list_requires_platform_admin(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A non-admin caller gets the standard not-found; an admin gets the envelope."""
    _seed_models(supabase)
    assert api.get(_LIST).status_code == 404
    admin = api.get(_LIST, headers=_ADMIN)
    assert admin.status_code == 200
    payload = admin.json()
    assert payload == {"deployments": [], "worker_base_url_configured": False}


def test_create_defaults_off_and_host_managed(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A new lane is staged (disabled), platform-funded, and public."""
    _seed_models(supabase)
    response = _create(api, base_url="https://vllm.internal:8000/v1")
    assert response.status_code == 201
    body = response.json()
    assert body["slug"] == "deepseek-v4-flash"
    assert body["display_name"] == "DeepSeek V4 Flash"
    deployment = body["deployment"]
    assert deployment["provider"] == "experiential_cloud"
    assert deployment["status"] == "disabled"
    assert deployment["billing_source"] == "host_managed"
    assert deployment["owning_org_id"] is None
    assert deployment["base_url"] == "https://vllm.internal:8000/v1"
    assert deployment["input_micro_usd_per_million"] == 42448

    rows = supabase.tables["model_providers"]
    assert len(rows) == 1
    assert rows[0]["model_id"] == "model-deepseek"
    assert rows[0]["status"] == "disabled"
    # The upstream bearer must never be persisted on the row.
    assert "api_key" not in rows[0]
    assert not any("key" in column.lower() for column in rows[0])


def test_create_unknown_public_slug_is_404(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A slug with no PUBLIC model is a not-found, ignoring org-owned rows."""
    _seed_models(supabase)
    response = _create(api, slug="no-such-model")
    assert response.status_code == 404
    assert supabase.tables["model_providers"] == []


def test_create_replay_is_idempotent(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """An identical replay converges on the existing row and answers 200."""
    _seed_models(supabase)
    first = _create(api, base_url="https://vllm.internal:8000/v1")
    assert first.status_code == 201
    second = _create(api, base_url="https://vllm.internal:8000/v1")
    assert second.status_code == 200
    assert len(supabase.tables["model_providers"]) == 1


def test_toggle_on_then_off(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Status flips active<->disabled and persists."""
    _seed_models(supabase)
    deployment_id = _seed_ec_deployment(supabase)

    on = api.post(f"{_LIST}/{deployment_id}/status", json={"status": "active"}, headers=_ADMIN)
    assert on.status_code == 200
    assert on.json()["deployment"]["status"] == "active"
    assert supabase.tables["model_providers"][0]["status"] == "active"

    off = api.post(f"{_LIST}/{deployment_id}/status", json={"status": "disabled"}, headers=_ADMIN)
    assert off.status_code == 200
    assert off.json()["deployment"]["status"] == "disabled"


def test_update_endpoint_and_prices(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """PATCH replaces the endpoint, wire id, and prices; stamps effective time."""
    _seed_models(supabase)
    deployment_id = _seed_ec_deployment(supabase)
    response = api.patch(
        f"{_LIST}/{deployment_id}",
        json={
            "provider_model_id": "deepseek-v4-flash-r2",
            "base_url": "https://vllm-2.internal:8000/v1",
            "input_micro_usd_per_million": 50000,
            "cached_input_micro_usd_per_million": 10000,
            "output_micro_usd_per_million": 90000,
        },
        headers=_ADMIN,
    )
    assert response.status_code == 200
    deployment = response.json()["deployment"]
    assert deployment["provider_model_id"] == "deepseek-v4-flash-r2"
    assert deployment["base_url"] == "https://vllm-2.internal:8000/v1"
    assert deployment["input_micro_usd_per_million"] == 50000
    assert deployment["pricing_effective_at"] is not None


def test_update_rejects_malformed_base_url(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A base_url outside the endpoint grammar is a 422 before any write."""
    _seed_models(supabase)
    deployment_id = _seed_ec_deployment(supabase)
    response = api.patch(
        f"{_LIST}/{deployment_id}",
        json={"provider_model_id": "x", "base_url": "not-a-url"},
        headers=_ADMIN,
    )
    assert response.status_code == 422


def test_status_rejects_unknown_value(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Only active/disabled are accepted; 'hidden' is refused at the boundary."""
    _seed_models(supabase)
    deployment_id = _seed_ec_deployment(supabase)
    response = api.post(
        f"{_LIST}/{deployment_id}/status", json={"status": "hidden"}, headers=_ADMIN
    )
    assert response.status_code == 422


def test_missing_deployment_is_404(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Update/toggle of an unknown or non-EC id is a not-found."""
    _seed_models(supabase)
    missing = "00000000-0000-0000-0000-000000000000"
    assert (
        api.patch(
            f"{_LIST}/{missing}",
            json={"provider_model_id": "x"},
            headers=_ADMIN,
        ).status_code
        == 404
    )
    assert (
        api.post(f"{_LIST}/{missing}/status", json={"status": "active"}, headers=_ADMIN).status_code
        == 404
    )


def test_mutations_require_platform_admin(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Create/update/toggle without admin authority are refused and persist nothing."""
    _seed_models(supabase)
    deployment_id = _seed_ec_deployment(supabase)
    assert (
        api.post(_LIST, json={"slug": "deepseek-v4-flash", "provider_model_id": "x"}).status_code
        == 404
    )
    assert api.patch(f"{_LIST}/{deployment_id}", json={"provider_model_id": "x"}).status_code == 404
    assert api.post(f"{_LIST}/{deployment_id}/status", json={"status": "active"}).status_code == 404
    assert supabase.tables["model_providers"][0]["status"] == "disabled"
    assert len(supabase.tables["model_providers"]) == 1
