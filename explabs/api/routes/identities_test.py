# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for the identity-tier management API.

These exercise the full HTTP surface (identities, grant matrix, budgets) against
the fake Supabase client. The reserve-time budget ENFORCEMENT and the balances
SQL are proven separately against real Postgres in the gateway integration
suite; here the budgets read seam is faked, so these tests assert the route
contract (auth gating, validation, shaping) rather than the spend math.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import (
    ORG_ID,
    ORG_KEY_ID,
    OTHER_ORG_ID,
    OUTSIDER_ID,
    USER_ID,
)
from explabs.db.fake_supabase_test import FakeSupabaseClient

DEFAULT_IDENTITY = f"org-{ORG_ID}"
PUBLIC_ALIAS = "alias-public"
OWN_ALIAS = "alias-own"
OTHER_ALIAS = "alias-other"


@pytest.fixture(autouse=True)
def _seed_identity_tier(supabase: FakeSupabaseClient) -> None:
    """Seed the org's default identity and a small alias catalog.

    Mirrors the P-A cutover: every org owns a default identity, and the alias
    catalog carries one public alias, one org-owned alias, and one belonging to
    a different org (which must never appear in this org's grantable set).
    """
    supabase.tables["gateway_identities"] = [
        {
            "identity_id": DEFAULT_IDENTITY,
            "org_id": ORG_ID,
            "display_name": "Default",
            "description": None,
            "active": True,
            "created_at": "2026-06-01T00:00:00Z",
            "updated_at": "2026-06-01T00:00:00Z",
        }
    ]
    supabase.tables["gateway_aliases"] = [
        {
            "alias_id": PUBLIC_ALIAS,
            "alias_name": "gpt-public",
            "origin": "catalog",
            "org_id": None,
            "active": True,
        },
        {
            "alias_id": OWN_ALIAS,
            "alias_name": "our-coder",
            "origin": "named",
            "org_id": ORG_ID,
            "active": True,
        },
        {
            "alias_id": OTHER_ALIAS,
            "alias_name": "their-coder",
            "origin": "named",
            "org_id": OTHER_ORG_ID,
            "active": True,
        },
    ]
    supabase.tables["gateway_grants"] = []
    supabase.tables["gateway_budgets"] = []


def _user_client(api: TestClient, user_id: str) -> TestClient:
    """A client acting as a specific (non-default) member or outsider."""
    api.headers["X-Explabs-Actor-Id"] = user_id
    return api


# -- Identities -------------------------------------------------------------


def test_list_identities_returns_default_first(api: TestClient) -> None:
    """List identities returns default first."""
    response = api.get(f"/api/orgs/{ORG_ID}/identities")
    assert response.status_code == 200
    identities = response.json()["identities"]
    assert identities[0]["identity_id"] == DEFAULT_IDENTITY
    assert identities[0]["is_default"] is True
    # The org-1 seed carries one active non-revoked key on the default identity
    # only after reparenting; the conftest keys have no identity_id, so the
    # count is zero here. The count is asserted directly below after a create.
    assert identities[0]["active_key_count"] == 0


def test_create_identity_then_appears_in_list(api: TestClient) -> None:
    """Create identity then appears in list."""
    created = api.post(
        f"/api/orgs/{ORG_ID}/identities",
        json={"display_name": "Data Team", "description": "batch jobs"},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["display_name"] == "Data Team"
    assert body["is_default"] is False
    assert body["active"] is True

    listing = api.get(f"/api/orgs/{ORG_ID}/identities").json()["identities"]
    assert any(item["identity_id"] == body["identity_id"] for item in listing)


def test_create_identity_rejects_reserved_prefix(api: TestClient) -> None:
    """Create identity rejects reserved prefix."""
    response = api.post(
        f"/api/orgs/{ORG_ID}/identities",
        json={"display_name": "Sneaky", "identity_id": "org-abc"},
    )
    assert response.status_code == 422


def test_create_identity_rejects_invalid_id(api: TestClient) -> None:
    """Create identity rejects invalid id."""
    response = api.post(
        f"/api/orgs/{ORG_ID}/identities",
        json={"display_name": "Bad", "identity_id": "Not Valid!"},
    )
    assert response.status_code == 422


def test_create_identity_conflict_on_duplicate(api: TestClient) -> None:
    """Create identity conflict on duplicate."""
    payload = {"display_name": "Team", "identity_id": "team-a"}
    assert api.post(f"/api/orgs/{ORG_ID}/identities", json=payload).status_code == 201
    assert api.post(f"/api/orgs/{ORG_ID}/identities", json=payload).status_code == 409


def test_create_identity_forbidden_for_non_admin(api: TestClient) -> None:
    """Create identity forbidden for non admin."""
    client = _user_client(api, USER_ID)
    response = client.post(f"/api/orgs/{ORG_ID}/identities", json={"display_name": "Nope"})
    assert response.status_code == 403


def test_identities_not_found_for_outsider(api: TestClient) -> None:
    """Identities not found for outsider."""
    client = _user_client(api, OUTSIDER_ID)
    response = client.get(f"/api/orgs/{ORG_ID}/identities")
    assert response.status_code == 404


def test_rename_identity(api: TestClient) -> None:
    """Rename identity."""
    created = api.post(f"/api/orgs/{ORG_ID}/identities", json={"display_name": "Old"}).json()
    renamed = api.patch(
        f"/api/orgs/{ORG_ID}/identities/{created['identity_id']}",
        json={"display_name": "New"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["display_name"] == "New"


def test_disable_identity_soft(api: TestClient) -> None:
    """Disable identity soft."""
    created = api.post(f"/api/orgs/{ORG_ID}/identities", json={"display_name": "Retire me"}).json()
    disabled = api.delete(f"/api/orgs/{ORG_ID}/identities/{created['identity_id']}")
    assert disabled.status_code == 200
    assert disabled.json()["active"] is False


def test_default_identity_cannot_be_disabled(api: TestClient) -> None:
    """Default identity cannot be disabled."""
    via_delete = api.delete(f"/api/orgs/{ORG_ID}/identities/{DEFAULT_IDENTITY}")
    assert via_delete.status_code == 409
    via_patch = api.patch(
        f"/api/orgs/{ORG_ID}/identities/{DEFAULT_IDENTITY}", json={"active": False}
    )
    assert via_patch.status_code == 409


# -- Grants -----------------------------------------------------------------


def test_grant_matrix_excludes_other_org_aliases(api: TestClient) -> None:
    """Grant matrix excludes other org aliases."""
    response = api.get(f"/api/orgs/{ORG_ID}/grants")
    assert response.status_code == 200
    matrix = response.json()
    alias_ids = {alias["alias_id"] for alias in matrix["aliases"]}
    assert PUBLIC_ALIAS in alias_ids
    assert OWN_ALIAS in alias_ids
    assert OTHER_ALIAS not in alias_ids
    assert matrix["grants"] == []


def test_add_and_remove_grant_is_idempotent(api: TestClient) -> None:
    """Add and remove grant is idempotent."""
    path = f"/api/orgs/{ORG_ID}/identities/{DEFAULT_IDENTITY}/grants/{PUBLIC_ALIAS}"
    first = api.put(path)
    assert first.status_code == 200
    assert first.json() == {"granted": True, "changed": True}
    second = api.put(path)
    assert second.json() == {"granted": True, "changed": False}

    matrix = api.get(f"/api/orgs/{ORG_ID}/grants").json()
    assert {"identity_id": DEFAULT_IDENTITY, "alias_id": PUBLIC_ALIAS} in matrix["grants"]

    removed = api.delete(path)
    assert removed.status_code == 200
    assert removed.json() == {"granted": False, "changed": True}
    assert api.delete(path).json() == {"granted": False, "changed": False}


def test_grant_to_unusable_alias_is_not_found(api: TestClient) -> None:
    """Grant to unusable alias is not found."""
    path = f"/api/orgs/{ORG_ID}/identities/{DEFAULT_IDENTITY}/grants/{OTHER_ALIAS}"
    assert api.put(path).status_code == 404


def test_grant_forbidden_for_non_admin(api: TestClient) -> None:
    """Grant forbidden for non admin."""
    client = _user_client(api, USER_ID)
    path = f"/api/orgs/{ORG_ID}/identities/{DEFAULT_IDENTITY}/grants/{PUBLIC_ALIAS}"
    assert client.put(path).status_code == 403


# -- Budgets ----------------------------------------------------------------


def test_set_identity_budget_then_list(api: TestClient) -> None:
    """Set identity budget then list."""
    identity = api.post(f"/api/orgs/{ORG_ID}/identities", json={"display_name": "Capped"}).json()
    put = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={
            "period": "2026-08",
            "scope_kind": "identity",
            "identity_id": identity["identity_id"],
            "limit_micro_usd": 5_000_000,
        },
    )
    assert put.status_code == 200
    body = put.json()
    assert body["limit_micro_usd"] == 5_000_000
    assert body["remaining_micro_usd"] == 5_000_000

    listing = api.get(f"/api/orgs/{ORG_ID}/budgets", params={"period": "2026-08"})
    assert listing.status_code == 200
    budgets = listing.json()["budgets"]
    assert len(budgets) == 1
    assert budgets[0]["scope_kind"] == "identity"


def test_set_budget_upserts_same_scope(api: TestClient) -> None:
    """Set budget upserts same scope."""
    base = {"period": "2026-08", "scope_kind": "team", "limit_micro_usd": 1_000_000}
    first = api.put(f"/api/orgs/{ORG_ID}/budgets", json=base).json()
    raised = api.put(
        f"/api/orgs/{ORG_ID}/budgets", json={**base, "limit_micro_usd": 2_000_000}
    ).json()
    assert first["budget_id"] == raised["budget_id"]
    assert raised["limit_micro_usd"] == 2_000_000
    listing = api.get(f"/api/orgs/{ORG_ID}/budgets", params={"period": "2026-08"}).json()
    assert len(listing["budgets"]) == 1


def test_budget_balance_reflects_spend(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Budget balance reflects spend."""
    put = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={"period": "2026-08", "scope_kind": "team", "limit_micro_usd": 10_000_000},
    ).json()
    supabase.tables["gateway_budget_spend"] = [
        {
            "budget_id": put["budget_id"],
            "reserved_micro_usd": 1_500_000,
            "settled_micro_usd": 3_000_000,
        }
    ]
    budgets = api.get(f"/api/orgs/{ORG_ID}/budgets", params={"period": "2026-08"}).json()["budgets"]
    assert budgets[0]["reserved_micro_usd"] == 1_500_000
    assert budgets[0]["settled_micro_usd"] == 3_000_000
    assert budgets[0]["remaining_micro_usd"] == 5_500_000


def test_identity_budget_requires_existing_identity(api: TestClient) -> None:
    """Identity budget requires existing identity."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={
            "period": "2026-08",
            "scope_kind": "identity",
            "identity_id": "ghost",
            "limit_micro_usd": 1,
        },
    )
    assert response.status_code == 404


def test_identity_budget_rejects_extraneous_scope(api: TestClient) -> None:
    """Identity budget rejects extraneous scope."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={
            "period": "2026-08",
            "scope_kind": "identity",
            "identity_id": DEFAULT_IDENTITY,
            "pool_id": "pool-x",
            "limit_micro_usd": 1,
        },
    )
    assert response.status_code == 422


def test_budget_rejects_bad_period(api: TestClient) -> None:
    """Budget rejects bad period."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={"period": "2026-8", "scope_kind": "team", "limit_micro_usd": 1},
    )
    assert response.status_code == 422


def test_budget_rejects_unknown_scope(api: TestClient) -> None:
    """Budget rejects unknown scope."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={"period": "2026-08", "scope_kind": "galaxy", "limit_micro_usd": 1},
    )
    assert response.status_code == 422


def test_delete_budget(api: TestClient) -> None:
    """Delete budget."""
    put = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={"period": "2026-08", "scope_kind": "team", "limit_micro_usd": 1},
    ).json()
    deleted = api.delete(f"/api/orgs/{ORG_ID}/budgets/{put['budget_id']}")
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert api.delete(f"/api/orgs/{ORG_ID}/budgets/{put['budget_id']}").status_code == 404


def test_set_key_budget_round_trips_api_key_id(api: TestClient) -> None:
    """Set key budget round trips api key id."""
    put = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={
            "period": "2026-08",
            "scope_kind": "key",
            "api_key_id": ORG_KEY_ID,
            "limit_micro_usd": 2_000_000,
        },
    )
    assert put.status_code == 200
    body = put.json()
    assert body["scope_kind"] == "key"
    assert body["api_key_id"] == ORG_KEY_ID
    assert body["remaining_micro_usd"] == 2_000_000

    budgets = api.get(f"/api/orgs/{ORG_ID}/budgets", params={"period": "2026-08"}).json()["budgets"]
    assert [budget["api_key_id"] for budget in budgets] == [ORG_KEY_ID]


def test_key_budget_rejects_foreign_org_key(api: TestClient) -> None:
    """Key budget rejects foreign org key."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={
            "period": "2026-08",
            "scope_kind": "key",
            # org-2's seeded key (conftest): must read as absent, not foreign.
            "api_key_id": "key-org2",
            "limit_micro_usd": 1,
        },
    )
    assert response.status_code == 404


def test_model_budget_accepts_grantable_alias(api: TestClient) -> None:
    """Model budget accepts grantable alias."""
    put = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={
            "period": "2026-08",
            "scope_kind": "model",
            "alias_id": OWN_ALIAS,
            "limit_micro_usd": 3_000_000,
        },
    )
    assert put.status_code == 200
    body = put.json()
    assert body["scope_kind"] == "model"
    assert body["alias_id"] == OWN_ALIAS


def test_model_budget_requires_alias_id(api: TestClient) -> None:
    """Model budget requires alias id."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={"period": "2026-08", "scope_kind": "model", "limit_micro_usd": 1},
    )
    assert response.status_code == 422


def test_recurring_budget_accepted_and_listed_for_month(api: TestClient) -> None:
    """Recurring budget accepted and listed for month."""
    put = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={"period": "*", "scope_kind": "team", "limit_micro_usd": 4_000_000},
    )
    assert put.status_code == 200
    body = put.json()
    assert body["period"] == "*"
    assert body["remaining_micro_usd"] == 4_000_000

    # A recurring row governs every month, so a pinned-month read folds it in.
    budgets = api.get(f"/api/orgs/{ORG_ID}/budgets", params={"period": "2026-08"}).json()["budgets"]
    assert [budget["period"] for budget in budgets] == ["*"]
    assert budgets[0]["budget_id"] == body["budget_id"]


def test_budget_rejects_out_of_range_month(api: TestClient) -> None:
    """Budget rejects out of range month."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={"period": "2026-13", "scope_kind": "team", "limit_micro_usd": 1},
    )
    assert response.status_code == 422


def test_team_budget_rejects_extraneous_api_key(api: TestClient) -> None:
    """Team budget rejects extraneous api key."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/budgets",
        json={
            "period": "2026-08",
            "scope_kind": "team",
            "api_key_id": ORG_KEY_ID,
            "limit_micro_usd": 1,
        },
    )
    assert response.status_code == 422


def test_list_budgets_forbidden_for_outsider(api: TestClient) -> None:
    """List budgets forbidden for outsider."""
    client = _user_client(api, OUTSIDER_ID)
    response = client.get(f"/api/orgs/{ORG_ID}/budgets", params={"period": "2026-08"})
    assert response.status_code == 404


# -- Customer-key isolation -------------------------------------------------


def test_customer_key_cannot_reach_management(customer_api: TestClient) -> None:
    """A customer xpl_ key is off the allowlist, so management 401s."""
    assert customer_api.get(f"/api/orgs/{ORG_ID}/identities").status_code == 401
    assert (
        customer_api.post(f"/api/orgs/{ORG_ID}/identities", json={"display_name": "x"}).status_code
        == 401
    )


# -- Audit wiring -------------------------------------------------------------


def test_identity_mutations_emit_audit_events(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A successful identity write is followed by exactly one audit emit."""
    created = api.post(f"/api/orgs/{ORG_ID}/identities", json={"display_name": "Audited"})
    assert created.status_code == 201
    assert supabase.executed_rpcs.count("record_audit_event") == 1
