# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for per-actor tenant authorization across the API surface."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import (
    OPERATOR_ID,
    ORG_ID,
    OTHER_ORG_ID,
    OUTSIDER_ID,
    USER_ID,
)
from explabs.api.routes import ApiError
from explabs.api.tenancy import RequestActor, require_platform_admin, resolve_acting_org
from explabs.db.fake_supabase_test import FakeSupabaseClient


def _as_actor(actor_id: str) -> dict[str, str]:
    """Headers overriding the default actor for one request."""
    return {"X-Explabs-Actor-Id": actor_id}


def test_api_routes_require_actor_header(api: TestClient) -> None:
    """Tenant-scoped routes fail closed when the caller asserts no actor."""
    response = api.get("/api/orgs", headers={"X-Explabs-Actor-Id": ""})

    assert response.status_code == 401
    assert "X-Explabs-Actor-Id" in response.json()["error"]


def test_list_orgs_is_scoped_to_actor_memberships(api: TestClient) -> None:
    """Org listing returns only accessible orgs with role and budget state."""
    user = api.get("/api/orgs", headers=_as_actor(USER_ID))
    outsider = api.get("/api/orgs", headers=_as_actor(OUTSIDER_ID))

    assert [(row["id"], row["role"]) for row in user.json()] == [(ORG_ID, "user")]
    assert user.json()[0]["spend_usd"] == 0
    assert user.json()[0]["credit_balance_usd"] == 20.0
    assert outsider.json() == []


def test_retired_session_routes_are_not_tenant_surfaces(api: TestClient) -> None:
    """No actor role can revive a route that is no longer mounted."""
    for actor_id in (USER_ID, OUTSIDER_ID, OPERATOR_ID):
        response = api.get("/api/sessions/retired", headers=_as_actor(actor_id))
        assert response.status_code == 404


def test_require_platform_admin_is_a_404_for_a_tenant_admin() -> None:
    """Operator surfaces answer not-found, so a tenant cannot enumerate them."""
    # 404 over 403 is the load-bearing half: a forbidden response would confirm
    # that a cross-org operator surface exists behind the path.
    require_platform_admin(RequestActor(user_id=OPERATOR_ID, is_platform_admin=True))

    with pytest.raises(ApiError) as denied:
        require_platform_admin(RequestActor(user_id=USER_ID, is_platform_admin=False))
    assert denied.value.status_code == 404
    assert str(denied.value) == "Not found"


def test_require_platform_admin_refuses_a_customer_api_key() -> None:
    """An org-scoped key is not an operator, whatever org it serves."""
    key_actor = RequestActor(
        user_id="api-key",
        is_platform_admin=False,
        api_key_org_id=ORG_ID,
        api_key_id="key-org1",
    )
    with pytest.raises(ApiError) as denied:
        require_platform_admin(key_actor)
    assert denied.value.status_code == 404


def test_resolve_acting_org_uses_the_key_org(supabase: FakeSupabaseClient) -> None:
    """An org API key names exactly its org without a membership lookup."""
    key_actor = RequestActor(user_id="unused", is_platform_admin=False, api_key_org_id=OTHER_ORG_ID)
    assert resolve_acting_org(supabase, key_actor) == OTHER_ORG_ID


def test_resolve_acting_org_resolves_sole_membership(supabase: FakeSupabaseClient) -> None:
    """A session actor with one membership resolves to that org."""
    actor = RequestActor(user_id=USER_ID, is_platform_admin=False)
    assert resolve_acting_org(supabase, actor) == ORG_ID


def test_resolve_acting_org_409s_for_multiple_memberships(supabase: FakeSupabaseClient) -> None:
    """Several memberships have no single answer; the 409 names the fix."""
    supabase.tables["organization_members"].append(
        {"org_id": OTHER_ORG_ID, "user_id": USER_ID, "role": "user"}
    )
    actor = RequestActor(user_id=USER_ID, is_platform_admin=False)
    with pytest.raises(ApiError) as excinfo:
        resolve_acting_org(supabase, actor)
    assert excinfo.value.status_code == 409


def test_resolve_acting_org_409s_for_a_platform_admin(supabase: FakeSupabaseClient) -> None:
    """Admins act across every org, so there is no single acting org."""
    actor = RequestActor(user_id=OPERATOR_ID, is_platform_admin=True)
    with pytest.raises(ApiError) as excinfo:
        resolve_acting_org(supabase, actor)
    assert excinfo.value.status_code == 409


def test_resolve_acting_org_404s_for_a_membership_less_actor(supabase: FakeSupabaseClient) -> None:
    """No membership means no acting org."""
    actor = RequestActor(user_id=OUTSIDER_ID, is_platform_admin=False)
    with pytest.raises(ApiError) as excinfo:
        resolve_acting_org(supabase, actor)
    assert excinfo.value.status_code == 404
