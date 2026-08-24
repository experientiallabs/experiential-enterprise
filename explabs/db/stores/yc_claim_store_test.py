# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the YC launch-grant store (label + generalized grant)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import SupabaseClient
from explabs.db.stores.yc_claim_store import YC_GRANT_USD, YcClaimStore

ORG_ID = "org-yc"
OTHER_ORG_ID = "org-other"
USER_ID = "user-founder"


@pytest.fixture
def supabase() -> FakeSupabaseClient:
    """Fake client with two orgs carrying the welcome grant."""
    client = FakeSupabaseClient()
    client.tables["organizations"] = [
        {
            "id": ORG_ID,
            "slug": "yc-tenant",
            "name": "YC Tenant",
            "credit_granted_usd": 20.0,
            "spend_usd": 3.0,
            "billable_spend_usd": 3.0,
        },
        {
            "id": OTHER_ORG_ID,
            "slug": "other-tenant",
            "name": "Other Tenant",
            "credit_granted_usd": 20.0,
            "spend_usd": 0.0,
            "billable_spend_usd": 0.0,
        },
    ]
    client.tables["credit_ledger"] = [
        {
            "id": f"promo-{org_id}",
            "org_id": org_id,
            "entry_type": "grant",
            "amount_usd": 20.0,
            "reason": "Welcome credit",
            "source": "signup_promo",
            "source_ref": None,
            "created_by": None,
            "created_at": "2026-08-01T00:00:00+00:00",
        }
        for org_id in (ORG_ID, OTHER_ORG_ID)
    ]
    return client


def test_apply_launch_grant_applies_label_grant_and_promo_fold(
    supabase: FakeSupabaseClient,
) -> None:
    """One apply writes the yc label, the grant, and the promo reversal."""
    result = YcClaimStore(supabase).apply_launch_grant(ORG_ID, YC_GRANT_USD, None, USER_ID)

    assert result.granted_usd == YC_GRANT_USD
    assert result.newly_applied is True
    # 20 promo + 526 grant - 20 reversal - 3 spent: total launch credit $526.
    assert result.balance_usd == 523.0
    assert result.org_slug == "yc-tenant"
    # The `yc` label marks the org a YC company.
    labels = [row for row in supabase.tables["org_labels"] if row["org_id"] == ORG_ID]
    assert [row["key"] for row in labels] == ["yc"]
    # The grant carries its expiry + spend snapshot for the clawback.
    grant = next(
        row
        for row in supabase.tables["credit_ledger"]
        if row.get("source_ref") == f"yc-launch:{ORG_ID}"
    )
    assert grant["amount_usd"] == YC_GRANT_USD
    assert grant["billable_spend_at_grant_usd"] == 3.0
    assert isinstance(grant["expires_at"], str)
    org_ledger = [row for row in supabase.tables["credit_ledger"] if row["org_id"] == ORG_ID]
    assert [(row["source"], row["amount_usd"]) for row in org_ledger] == [
        ("signup_promo", 20.0),
        ("yc_launch", 526.0),
        ("yc_launch", -20.0),
    ]


def test_apply_launch_grant_is_idempotent_per_org(supabase: FakeSupabaseClient) -> None:
    """A replay applies neither a second grant nor a second reversal."""
    store = YcClaimStore(supabase)
    store.apply_launch_grant(ORG_ID, YC_GRANT_USD, None, USER_ID)
    ledger_after_first = len(supabase.tables["credit_ledger"])

    replay = store.apply_launch_grant(ORG_ID, YC_GRANT_USD, None, "user-cofounder")
    assert replay.newly_applied is False
    assert len(supabase.tables["credit_ledger"]) == ledger_after_first
    # Still exactly one yc label.
    labels = [row for row in supabase.tables["org_labels"] if row["org_id"] == ORG_ID]
    assert len(labels) == 1


def test_apply_launch_grant_honors_an_explicit_amount_and_expiry(
    supabase: FakeSupabaseClient,
) -> None:
    """The admin lane sets its own amount + expiry."""
    result = YcClaimStore(supabase).apply_launch_grant(
        ORG_ID, 1000.0, "2027-01-01T00:00:00+00:00", USER_ID
    )
    assert result.granted_usd == 1000.0
    assert result.expires_at == "2027-01-01T00:00:00+00:00"


def test_is_yc_company_reflects_the_label(supabase: FakeSupabaseClient) -> None:
    """YC-company status is the presence of the `yc` label."""
    store = YcClaimStore(supabase)
    assert store.is_yc_company(ORG_ID) is False

    store.apply_launch_grant(ORG_ID, YC_GRANT_USD, None, USER_ID)
    assert store.is_yc_company(ORG_ID) is True
    # A different org without the label is not YC.
    assert store.is_yc_company(OTHER_ORG_ID) is False


def test_process_expiries_returns_the_scalar_count() -> None:
    """The expiry rpc returns a bare integer, not rows."""

    @dataclass(frozen=True)
    class ScalarResult:
        data: object

    class ScalarRpcClient:
        def rpc(self, fn: str, params: object = None) -> ScalarRpcClient:
            assert fn == "process_expiring_grants"
            _ = params
            return self

        def execute(self) -> ScalarResult:
            return ScalarResult(data=2)

    # Narrow-boundary cast: the double implements exactly the one rpc call the
    # method under test performs; the full protocol would drag in table reads.
    store = YcClaimStore(cast("SupabaseClient", ScalarRpcClient()))
    assert store.process_expiries() == 2


def test_process_expiring_grants_claws_back_unspent(supabase: FakeSupabaseClient) -> None:
    """An expired grant's unspent part is clawed back, capped so balance >= 0."""
    org = supabase.tables["organizations"][0]
    store = YcClaimStore(supabase)
    store.apply_launch_grant(ORG_ID, YC_GRANT_USD, "2020-01-01T00:00:00+00:00", USER_ID)
    # After the fold the balance is $523 (526 granted - 3 already billable). The
    # grant is already expired (2020) and nothing was spent since it landed, so
    # its unspent part is the full $526 — but the clawback is capped at the live
    # $523 balance so the balance never goes negative.
    balance_before = cast("float", org["credit_granted_usd"]) - cast("float", org["billable_spend_usd"])
    assert balance_before == 523.0

    processed = store.process_expiries()
    assert processed == 1
    balance_after = cast("float", org["credit_granted_usd"]) - cast("float", org["billable_spend_usd"])
    assert balance_after == 0.0
    # Idempotent: a second pass processes nothing.
    assert store.process_expiries() == 0
