# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The internal balance-fetch route: deployment-key gated, runs the scheduler."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import CUSTOMER_KEY_SECRET
from explabs.db.fake_supabase_test import FakeSupabaseClient


def test_deployment_key_runs_the_scheduled_fetch(api: TestClient) -> None:
    """The web app's deployment key reaches the runner and gets a summary."""
    response = api.post("/api/internal/balance-fetch")
    assert response.status_code == 200
    body = response.json()
    assert body["providers_checked"] == 0
    assert body["tool_accounts_checked"] == 0
    assert body["errors"] == 0


def test_unauthenticated_caller_is_rejected(supabase: FakeSupabaseClient) -> None:
    """No credential cannot reach the machine route."""
    client = TestClient(create_app(client=supabase))
    response = client.post("/api/internal/balance-fetch")
    assert response.status_code == 401


def test_customer_key_cannot_reach_the_internal_route(supabase: FakeSupabaseClient) -> None:
    """A customer API key is not on the allowlist, so it is refused (401)."""
    client = TestClient(create_app(client=supabase))
    response = client.post(
        "/api/internal/balance-fetch",
        headers={"Authorization": f"Bearer {CUSTOMER_KEY_SECRET}"},
    )
    assert response.status_code == 401


def test_deployment_key_runs_the_broadcast_tick(api: TestClient) -> None:
    """The web app's deployment key drains the (empty) broadcast queue."""
    response = api.post("/api/internal/broadcast")
    assert response.status_code == 200
    assert response.json() == {"broadcast": 0, "skipped_no_destination": 0, "failed": 0}


def test_customer_key_cannot_reach_the_broadcast_route(supabase: FakeSupabaseClient) -> None:
    """A customer API key is refused before the broadcaster runs."""
    client = TestClient(create_app(client=supabase))
    response = client.post(
        "/api/internal/broadcast",
        headers={"Authorization": f"Bearer {CUSTOMER_KEY_SECRET}"},
    )
    assert response.status_code == 401
