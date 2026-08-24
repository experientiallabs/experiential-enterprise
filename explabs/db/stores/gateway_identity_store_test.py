# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Unit tests for the gateway identity-tier store helpers and data access."""

from __future__ import annotations

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.gateway_identity_store import (
    BudgetBalance,
    GatewayIdentityStore,
    default_identity_id,
    is_valid_identity_id,
    slugify_identity_id,
)

ORG_ID = "11111111-1111-1111-1111-111111111111"


def test_default_identity_id_matches_control_store_synthesis() -> None:
    """Default identity id matches control store synthesis."""
    assert default_identity_id(ORG_ID) == f"org-{ORG_ID}"


def test_slugify_produces_valid_ids() -> None:
    """Slugify produces valid ids."""
    generated = slugify_identity_id("Data & Analytics Team!", ORG_ID)
    assert is_valid_identity_id(generated)
    assert generated.startswith("data-analytics-team-")


def test_slugify_prefixes_leading_digit() -> None:
    """Slugify prefixes leading digit."""
    generated = slugify_identity_id("2024 cohort", ORG_ID)
    assert is_valid_identity_id(generated)
    assert generated[0].isalpha()


def test_slugify_handles_all_symbols() -> None:
    """Slugify handles all symbols."""
    generated = slugify_identity_id("!!!", ORG_ID)
    assert is_valid_identity_id(generated)


def test_slugify_avoids_reserved_org_prefix() -> None:
    """A display name that would slug into the reserved 'org-' prefix is escaped."""
    for name in ("Org", "org 1", "ORG team"):
        generated = slugify_identity_id(name, ORG_ID)
        assert is_valid_identity_id(generated)
        assert not generated.startswith("org-")


def test_is_valid_identity_id_rejects_uppercase_and_spaces() -> None:
    """Is valid identity id rejects uppercase and spaces."""
    assert not is_valid_identity_id("Not Valid")
    assert not is_valid_identity_id("UPPER")
    assert is_valid_identity_id("org-1")
    assert is_valid_identity_id("team.a_b-c")


def test_budget_balance_remaining_floors_at_zero() -> None:
    """Budget balance remaining floors at zero."""
    balance = BudgetBalance(
        budget_id="b1",
        period="2026-08",
        scope_kind="team",
        api_key_id=None,
        identity_id=None,
        alias_id=None,
        pool_id=None,
        deployment_id=None,
        limit_micro_usd=1_000,
        reserved_micro_usd=800,
        settled_micro_usd=400,
    )
    # Reserved + settled exceeds the limit; remaining never goes negative.
    assert balance.remaining_micro_usd == 0


def test_create_and_get_identity_roundtrip() -> None:
    """Create and get identity roundtrip."""
    client = FakeSupabaseClient()
    client.tables["gateway_identities"] = []
    store = GatewayIdentityStore(client)
    created = store.create_identity(
        org_id=ORG_ID,
        identity_id="team-a",
        display_name="Team A",
        description="  ",
    )
    assert created.identity_id == "team-a"
    assert created.active is True
    fetched = store.get_identity(ORG_ID, "team-a")
    assert fetched is not None
    assert fetched.display_name == "Team A"


def test_active_key_counts_only_unrevoked() -> None:
    """Active key counts only unrevoked."""
    client = FakeSupabaseClient()
    client.tables["gateway_identities"] = [
        {
            "identity_id": "team-a",
            "org_id": ORG_ID,
            "display_name": "Team A",
            "description": None,
            "active": True,
            "created_at": "2026-06-01T00:00:00Z",
            "updated_at": "2026-06-01T00:00:00Z",
        }
    ]
    client.tables["api_keys"] = [
        {"id": "k1", "org_id": ORG_ID, "identity_id": "team-a", "revoked_at": None},
        {
            "id": "k2",
            "org_id": ORG_ID,
            "identity_id": "team-a",
            "revoked_at": "2026-07-01T00:00:00Z",
        },
    ]
    store = GatewayIdentityStore(client)
    summaries = store.list_identities(ORG_ID)
    assert summaries[0].active_key_count == 1


def test_grantable_aliases_filters_other_orgs() -> None:
    """Grantable aliases filters other orgs."""
    client = FakeSupabaseClient()
    client.tables["gateway_aliases"] = [
        {
            "alias_id": "a-pub",
            "alias_name": "pub",
            "origin": "catalog",
            "org_id": None,
            "active": True,
        },
        {
            "alias_id": "a-own",
            "alias_name": "own",
            "origin": "named",
            "org_id": ORG_ID,
            "active": True,
        },
        {
            "alias_id": "a-off",
            "alias_name": "off",
            "origin": "catalog",
            "org_id": None,
            "active": False,
        },
        {
            "alias_id": "a-other",
            "alias_name": "oth",
            "origin": "named",
            "org_id": "other",
            "active": True,
        },
    ]
    store = GatewayIdentityStore(client)
    aliases = {alias.alias_id for alias in store.list_grantable_aliases(ORG_ID)}
    assert aliases == {"a-pub", "a-own"}
