# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the historical usage-import endpoint and its read-back."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.conftest import OPERATOR_ID, ORG_ID, OTHER_ORG_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient


def _record(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "model": "claude-opus-4-8",
        "input_tokens": 1_000_000,
        "output_tokens": 500_000,
        "cached_tokens": 0,
        "reasoning_tokens": 0,
        "timestamp": "2026-07-04T21:54:44.984Z",
        "source": "claude-code",
    }
    base.update(overrides)
    return base


def test_import_writes_and_reads_back_imported_spend(
    customer_api: TestClient, api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An org key imports a batch; a member reads per-model spend back.

    The org key writes the batch; the telemetry read path is reached by the
    web app (deployment key) acting as a signed-in member, so the read-back
    uses the member client, not the org key.
    """
    response = customer_api.post(
        "/api/gateway/usage/import",
        json={
            "batch_id": "batch-1",
            "records": [
                _record(),
                _record(model="gpt-5.6-sol", source="codex", cached_tokens=200_000),
                _record(model="o4-mini", source="codex"),
            ],
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["imported"] == 3
    assert body["duplicates"] == 0
    assert body["unmatched_models"] == ["o4-mini"]
    assert body["totals"]["cost_usd"] > 0

    read = api.get(f"/api/orgs/{ORG_ID}/usage/imported")
    assert read.status_code == 200, read.text
    models = {row["model"]: row for row in read.json()["models"]}
    assert models["claude-opus-4-8"]["cost_usd"] > 0
    assert models["claude-opus-4-8"]["model_matched"] is True
    # The unknown model is recorded but carries no attributed cost.
    assert models["o4-mini"]["model_matched"] is False
    assert models["o4-mini"]["cost_usd"] == 0


def test_import_is_idempotent(customer_api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Replaying the same batch imports nothing new."""
    payload = {"batch_id": "batch-1", "records": [_record(), _record(model="gpt-5.6-sol")]}
    first = customer_api.post("/api/gateway/usage/import", json=payload)
    assert first.json()["imported"] == 2
    second = customer_api.post("/api/gateway/usage/import", json=payload)
    assert second.status_code == 201
    assert second.json()["imported"] == 0
    assert second.json()["duplicates"] == 2


def test_distinct_turns_sharing_timestamp_are_not_deduped(
    customer_api: TestClient, api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Native event ids keep two identical-looking turns distinct."""
    same = {
        "model": "claude-opus-4-8",
        "input_tokens": 10,
        "output_tokens": 5,
        "timestamp": "2026-07-04T21:54:44.000Z",
        "source": "claude-code",
    }
    response = customer_api.post(
        "/api/gateway/usage/import",
        json={
            "batch_id": "b",
            "records": [
                {**same, "event_id": "msg_1"},
                {**same, "event_id": "msg_2"},
            ],
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["imported"] == 2
    read = api.get(f"/api/orgs/{ORG_ID}/usage/imported").json()
    assert read["totals"]["request_count"] == 2


def test_import_empty_batch_is_rejected(
    customer_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An empty batch is a client error, not a silent success."""
    response = customer_api.post("/api/gateway/usage/import", json={"batch_id": "b", "records": []})
    assert response.status_code == 400


def test_import_requires_org_scope(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A deployment key with no org and no org_id cannot import."""
    response = api.post("/api/gateway/usage/import", json={"batch_id": "b", "records": [_record()]})
    assert response.status_code == 403


def test_org_key_cannot_import_into_another_org(
    customer_api: TestClient, api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An org key's org_id override is ignored; the key's own org wins."""
    response = customer_api.post(
        "/api/gateway/usage/import",
        json={"batch_id": "b", "records": [_record()], "org_id": OTHER_ORG_ID},
    )
    assert response.status_code == 201
    # The record landed in the key's own org, not the org_id it named.
    own = api.get(f"/api/orgs/{ORG_ID}/usage/imported").json()
    assert own["totals"]["request_count"] == 1
    # A non-member reading the other org gets a foreign-org 404.
    assert api.get(f"/api/orgs/{OTHER_ORG_ID}/usage/imported").status_code == 404


def test_platform_admin_can_import_for_a_named_org(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A platform admin may target an org explicitly via org_id."""
    response = api.post(
        "/api/gateway/usage/import",
        json={"batch_id": "b", "records": [_record()], "org_id": ORG_ID},
        headers={"X-Explabs-Actor-Id": OPERATOR_ID},
    )
    assert response.status_code == 201, response.text
    assert response.json()["imported"] == 1


def test_admin_import_attributes_the_actor_and_emits_audit(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A platform-admin import records who ran it and emits one audit event."""
    response = api.post(
        "/api/gateway/usage/import",
        json={"batch_id": "attributed", "records": [_record()], "org_id": ORG_ID},
        headers={"X-Explabs-Actor-Id": OPERATOR_ID},
    )
    assert response.status_code == 201, response.text
    rows = supabase.tables["gateway_imported_usage_events"]
    assert [row["user_id"] for row in rows] == [OPERATOR_ID]
    assert supabase.executed_rpcs.count("record_audit_event") == 1


def test_org_key_import_carries_no_end_user(
    customer_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An organization-key import has no end user to attribute."""
    response = customer_api.post(
        "/api/gateway/usage/import",
        json={"batch_id": "keyed", "records": [_record()]},
    )
    assert response.status_code == 201, response.text
    rows = supabase.tables["gateway_imported_usage_events"]
    assert [row["user_id"] for row in rows] == [None]
