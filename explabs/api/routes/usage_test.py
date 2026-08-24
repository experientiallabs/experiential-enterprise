# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the org usage route."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.conftest import ORG_ID, OTHER_ORG_ID, TEST_API_KEY, USER_ID
from explabs.api.training_defaults import DEFAULT_CREATE_TRAINING_CAP_USD, MAX_TRAINING_CAP_USD
from explabs.db.fake_supabase_test import FakeSupabaseClient


def test_org_usage_returns_counters_only(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """The usage read is the cheap counters-only view: no scans, no breakdowns.

    The per-model and per-endpoint folds were deleted with the legacy usage
    views (usage-by-model belongs to the telemetry surfaces), so the response
    carries exactly the trigger-maintained counters the enforcement gate
    reads, plus the YC claim block.
    """
    org = next(row for row in supabase.tables["organizations"] if row["id"] == ORG_ID)
    org["spend_usd"] = 12.5
    org["billable_spend_usd"] = 12.5
    supabase.executed_selects.clear()

    response = api.get(f"/api/orgs/{ORG_ID}/usage")

    assert response.status_code == 200
    assert response.json() == {
        "credit": {
            "spend_usd": 12.5,
            "billable_spend_usd": 12.5,
            "credit_granted_usd": 20.0,
            "credit_balance_usd": 7.5,
            "yc": None,
        }
    }
    # One organizations read (plus the membership gate); never a spend scan.
    assert supabase.executed_selects.count("organizations") == 1
    for scanned in ("wm_sessions", "wm_rollouts", "build_jobs", "serving_requests"):
        assert supabase.executed_selects.count(scanned) == 0


def test_org_usage_unknown_org_is_404(api: TestClient) -> None:
    """The usage view 404s for unknown organizations."""
    response = api.get("/api/orgs/no-such-org/usage")

    assert response.status_code == 404


def test_org_usage_foreign_org_is_404(api: TestClient) -> None:
    """Another tenant's spend is indistinguishable from an absent org."""
    response = api.get(f"/api/orgs/{OTHER_ORG_ID}/usage")

    assert response.status_code == 404


def test_org_budget_returns_trigger_maintained_counter(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """The live budget read returns one org row without a usage-table scan."""
    org = next(row for row in supabase.tables["organizations"] if row["id"] == ORG_ID)
    org["spend_usd"] = 7.125
    org["billable_spend_usd"] = 7.125
    org["credit_granted_usd"] = 20

    response = api.get(f"/api/orgs/{ORG_ID}/budget")

    assert response.status_code == 200
    assert response.json() == {
        "spend_usd": 7.125,
        "billable_spend_usd": 7.125,
        "credit_granted_usd": 20.0,
        "credit_balance_usd": 12.875,
        # The automatic-training ceiling rides the budget read (Settings -> Usage).
        "training_cap_usd": None,
        "training_cap_default_usd": DEFAULT_CREATE_TRAINING_CAP_USD,
        # No /yc claim on the fixture org; the block is an honest null.
        "yc": None,
    }


def test_org_budget_reads_the_organizations_row_once(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """The credit counters and the training cap come off ONE read.

    The sidebar polls this route every 3s on every workspace page, which makes
    it the highest-volume authenticated request in the product, and both halves
    of its payload are columns on the same row.
    """
    supabase.executed_selects.clear()

    response = api.get(f"/api/orgs/{ORG_ID}/budget")

    assert response.status_code == 200
    assert supabase.executed_selects.count("organizations") == 1


def test_org_budget_foreign_org_is_404(api: TestClient) -> None:
    """The lightweight counter read preserves the usage route's tenant hiding."""
    response = api.get(f"/api/orgs/{OTHER_ORG_ID}/budget")

    assert response.status_code == 404


def test_training_cap_write_is_admin_gated_and_validated(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The ceiling authorizes real dollars per creation, so it is an admin control."""
    ok = api.put(f"/api/orgs/{ORG_ID}/training-cap", json={"training_cap_usd": 42.5})
    assert ok.status_code == 200
    assert ok.json()["training_cap_usd"] == 42.5
    row = next(r for r in supabase.tables["organizations"] if r["id"] == ORG_ID)
    assert row["training_cap_usd"] == 42.5

    # Null resets to the platform default, visible in the same response.
    reset = api.put(f"/api/orgs/{ORG_ID}/training-cap", json={"training_cap_usd": None})
    assert reset.status_code == 200
    assert reset.json()["training_cap_usd"] is None
    assert reset.json()["training_cap_default_usd"] == DEFAULT_CREATE_TRAINING_CAP_USD

    # A typo should cost an argument with the API, not a bill.
    for bad in (0, -5, MAX_TRAINING_CAP_USD + 1):
        refused = api.put(f"/api/orgs/{ORG_ID}/training-cap", json={"training_cap_usd": bad})
        assert refused.status_code == 422, bad


def test_training_cap_write_refuses_a_plain_member(api: TestClient) -> None:
    """A member can read the budget but not raise what creations may spend."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/training-cap",
        json={"training_cap_usd": 10.0},
        headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
    )
    assert response.status_code in (403, 404)


def test_training_cap_write_emits_an_audit_event(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The training-cap spend control write is followed by one audit emit."""
    response = api.put(f"/api/orgs/{ORG_ID}/training-cap", json={"training_cap_usd": 40})
    assert response.status_code == 200
    assert supabase.executed_rpcs.count("record_audit_event") == 1
