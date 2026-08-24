# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Customer API-key handling at the edge after the /v1 auth authority moved.

The gateway worker validates ``xpl_`` keys itself (``explabs/gateway``), so
the edge no longer pre-validates bearers on the proxied /v1 surface; what it
still owns is keeping customer keys off every control route.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import ACTOR_ID, ORG_ID, REVOKED_KEY_SECRET


def _as_key(secret: str) -> dict[str, str]:
    """Headers presenting a customer API key as the bearer credential."""
    return {"Authorization": f"Bearer {secret}"}


def test_customer_key_is_rejected_off_the_serving_surface(customer_api: TestClient) -> None:
    """Disallowed control routes 401 for valid and invalid keys alike.

    The org list and spend rollups are dashboard surfaces, not part of the
    key-callable API, so a valid key still gets the same 401 an unknown key
    would — the allowlist decides before the key lookup, closing the probe
    oracle.
    """
    orgs = customer_api.get("/api/orgs")
    usage = customer_api.get(f"/api/orgs/{ORG_ID}/usage")

    assert orgs.status_code == 401
    assert usage.status_code == 401


def test_customer_key_ignores_a_forged_actor_header_on_control_routes(
    customer_api: TestClient,
) -> None:
    """A key holder cannot reach control routes by naming a real user as actor."""
    response = customer_api.get(
        "/api/orgs",
        headers={"X-Explabs-Actor-Id": ACTOR_ID, "X-Explabs-Org-Id": "org-2"},
    )

    assert response.status_code == 401


def test_edge_no_longer_prevalidates_keys_on_the_proxied_v1_surface(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Even a revoked key is forwarded, not edge-401d: the worker decides.

    Without a configured worker origin the proxy fails closed with 503,
    proving the request went to the relay rather than an edge key lookup
    (which would have answered 401).
    """
    monkeypatch.delenv("EXPLABS_GATEWAY_WORKER_URL", raising=False)
    response = api.get("/v1/models", headers=_as_key(REVOKED_KEY_SECRET))

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "service_unavailable"
