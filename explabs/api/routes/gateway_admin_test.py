# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the gateway control endpoints.

Route tests run against the fake Supabase client (authz, shapes, grouping,
pagination). The integration half runs the real read RPCs against Postgres
(`SUPABASE_DB_URL`), including the Overview rollup's performance bar on a
seeded 90-day fixture.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import Connection

from explabs.api.app import create_app
from explabs.api.conftest import (
    ACTOR_ID,
    CUSTOMER_KEY_SECRET,
    OPERATOR_ID,
    ORG_ID,
    ORG_KEY_ID,
    OTHER_ORG_ID,
    OUTSIDER_ID,
    TEST_API_KEY,
    USER_ID,
)

if TYPE_CHECKING:
    from explabs.db.fake_supabase_test import FakeSupabaseClient

_UNATTRIBUTED = "00000000-0000-0000-0000-000000000000"
_SNAPSHOT_SHA = "a" * 64
_OTHER_ORG_USER = "user-other-org"


def _daily_row(
    org_id: str,
    user_id: str,
    day: str,
    alias: str,
    *,
    requests: int,
    input_tokens: int,
    output_tokens: int,
    spend_micro_usd: int,
) -> dict[str, object]:
    """Build one seeded gateway_usage_daily row."""
    return {
        "org_id": org_id,
        "user_id": user_id,
        "day": day,
        "alias": alias,
        "requests": requests,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "spend_micro_usd": spend_micro_usd,
    }


def _event_row(
    request_id: str,
    org_id: str,
    api_key_id: str,
    *,
    day: str,
    created_at: str,
    cost_micro_usd: int = 0,
    estimated_cost_micro_usd: int = 0,
    lane: str = "platform_funded",
) -> dict[str, object]:
    """Build one seeded gateway_usage_events row."""
    return {
        "request_id": request_id,
        "org_id": org_id,
        "api_key_id": api_key_id,
        "user_id": ACTOR_ID,
        "alias": "gpt-5",
        "provider": "openai",
        "lane": lane,
        "input_tokens": 10,
        "output_tokens": 5,
        "cost_micro_usd": cost_micro_usd,
        "estimated_cost_micro_usd": estimated_cost_micro_usd,
        "latency_ms": 120,
        "status": "completed",
        "attempt_count": 1,
        "day": day,
        "created_at": created_at,
    }


@pytest.fixture
def gateway_supabase(supabase: FakeSupabaseClient) -> FakeSupabaseClient:
    """Seed gateway usage, workers, catalog, and connection fixtures."""
    supabase.tables["gateway_usage_daily"] = [
        _daily_row(
            ORG_ID,
            ACTOR_ID,
            "2026-08-01",
            "gpt-5",
            requests=2,
            input_tokens=100,
            output_tokens=50,
            spend_micro_usd=400,
        ),
        _daily_row(
            ORG_ID,
            ACTOR_ID,
            "2026-08-02",
            "gpt-5",
            requests=1,
            input_tokens=10,
            output_tokens=5,
            spend_micro_usd=100,
        ),
        _daily_row(
            ORG_ID,
            ACTOR_ID,
            "2026-08-02",
            "claude-opus-5",
            requests=1,
            input_tokens=20,
            output_tokens=10,
            spend_micro_usd=900,
        ),
        _daily_row(
            ORG_ID,
            USER_ID,
            "2026-08-02",
            "gpt-5",
            requests=4,
            input_tokens=40,
            output_tokens=20,
            spend_micro_usd=250,
        ),
        _daily_row(
            ORG_ID,
            _UNATTRIBUTED,
            "2026-08-02",
            "gpt-5",
            requests=1,
            input_tokens=1,
            output_tokens=1,
            spend_micro_usd=7,
        ),
        _daily_row(
            OTHER_ORG_ID,
            _OTHER_ORG_USER,
            "2026-08-02",
            "gpt-5",
            requests=9,
            input_tokens=9,
            output_tokens=9,
            spend_micro_usd=999,
        ),
    ]
    supabase.tables["gateway_usage_events"] = [
        _event_row(
            "req-1",
            ORG_ID,
            ORG_KEY_ID,
            day="2026-08-01",
            created_at="2026-08-01T10:00:00+00:00",
            cost_micro_usd=100,
        ),
        _event_row(
            "req-2",
            ORG_ID,
            ORG_KEY_ID,
            day="2026-08-02",
            created_at="2026-08-02T10:00:00+00:00",
            estimated_cost_micro_usd=55,
            lane="pass_through",
        ),
        _event_row(
            "req-3",
            ORG_ID,
            "key-org1-second",
            day="2026-08-02",
            created_at="2026-08-02T11:00:00+00:00",
            cost_micro_usd=200,
        ),
        _event_row(
            "req-other",
            OTHER_ORG_ID,
            "key-org2",
            day="2026-08-02",
            created_at="2026-08-02T12:00:00+00:00",
        ),
    ]
    now = datetime.now(tz=UTC)
    supabase.tables["gateway_workers"] = [
        {
            "worker_id": "worker-fresh",
            "state": "ready",
            "started_at": (now - timedelta(hours=1)).isoformat(),
            "heartbeat_at": (now - timedelta(seconds=10)).isoformat(),
            "catalog_sha256": _SNAPSHOT_SHA,
            "app_version": "abc123",
        },
        {
            "worker_id": "worker-stale",
            "state": "ready",
            "started_at": (now - timedelta(hours=2)).isoformat(),
            "heartbeat_at": (now - timedelta(seconds=300)).isoformat(),
            "catalog_sha256": None,
            "app_version": None,
        },
    ]
    supabase.tables["gateway_catalog_snapshots"] = [
        {
            "catalog_sha256": _SNAPSHOT_SHA,
            "document": {
                "schema_version": 1,
                "deployments": [
                    {
                        "deployment_id": "dep-openai",
                        "provider": "openai",
                        "billing_source": "host_managed",
                    },
                    {
                        "deployment_id": "dep-anthropic",
                        "provider": "anthropic",
                        "billing_source": "host_managed",
                    },
                    {
                        "deployment_id": "dep-org1-byok",
                        "provider": "openai",
                        "billing_source": "customer_managed",
                    },
                ],
                "pools": [
                    {
                        "pool_id": "pool-public",
                        "deployment_ids": ["dep-openai", "dep-anthropic"],
                    },
                    {"pool_id": "pool-org1", "deployment_ids": ["dep-org1-byok"]},
                ],
            },
            "models_document": {},
        },
    ]
    supabase.tables["gateway_aliases"] = [
        {
            "alias_id": "alias-public-gpt5",
            "alias_name": "gpt-5",
            "org_id": None,
            "active": True,
            "current_revision_id": "rev-public-gpt5",
        },
        {
            "alias_id": "alias-public-shadowed",
            "alias_name": "shadow-me",
            "org_id": None,
            "active": True,
            "current_revision_id": "rev-public-shadowed",
        },
        {
            "alias_id": "alias-org1-shadow",
            "alias_name": "shadow-me",
            "org_id": ORG_ID,
            "active": True,
            "current_revision_id": "rev-org1-shadow",
        },
        {
            "alias_id": "alias-org2-custom",
            "alias_name": "org2-model",
            "org_id": OTHER_ORG_ID,
            "active": True,
            "current_revision_id": "rev-org2-custom",
        },
        {
            "alias_id": "alias-public-retired",
            "alias_name": "retired-model",
            "org_id": None,
            "active": False,
            "current_revision_id": "rev-public-retired",
        },
    ]

    def _revision(revision_id: str, alias_id: str, pool_id: str) -> dict[str, object]:
        return {
            "revision_id": revision_id,
            "alias_id": alias_id,
            "target": {"kind": "direct", "pool_id": pool_id},
            "catalog_sha256": _SNAPSHOT_SHA,
            "provider_connection_revisions": {},
            "certification": None,
            "refusal_failover": False,
        }

    supabase.tables["gateway_alias_revisions"] = [
        _revision("rev-public-gpt5", "alias-public-gpt5", "pool-public"),
        _revision("rev-public-shadowed", "alias-public-shadowed", "pool-public"),
        _revision("rev-org1-shadow", "alias-org1-shadow", "pool-org1"),
        _revision("rev-org2-custom", "alias-org2-custom", "pool-public"),
        _revision("rev-public-retired", "alias-public-retired", "pool-public"),
    ]
    supabase.tables["provider_connections"] = [
        {"id": "conn-org1-anthropic", "org_id": ORG_ID, "provider": "anthropic", "config": {}},
    ]
    supabase.tables["gateway_key_limits"] = []
    supabase.tables["credit_ledger"] = []
    supabase.tables["api_keys"].append(
        {
            "id": "key-org1-second",
            "org_id": ORG_ID,
            "name": "org-1 second key",
            "key_prefix": "xpl_second",
            "key_suffix": None,
            "key_hash": "b" * 64,
            "created_by": ACTOR_ID,
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            "expires_at": None,
        }
    )
    return supabase


def _client(supabase: FakeSupabaseClient, actor_id: str) -> TestClient:
    """Deployment-key client acting as one end user."""
    return TestClient(
        create_app(client=supabase),
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": actor_id,
        },
    )


def _customer_client(supabase: FakeSupabaseClient) -> TestClient:
    """Client authenticated with org-1's customer API key (no actor)."""
    return TestClient(
        create_app(client=supabase),
        headers={"Authorization": f"Bearer {CUSTOMER_KEY_SECRET}"},
    )


class TestUsageDaily:
    """GET /api/gateway/usage/daily."""

    def test_self_day_series_sums_across_models(self, gateway_supabase: FakeSupabaseClient) -> None:
        """scope=self returns the actor's per-day totals, newest first."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/daily", params={"org_id": ORG_ID}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["org_id"] == ORG_ID
        assert body["scope"] == "self"
        assert body["group_by"] == "day"
        assert body["rows"] == [
            {
                "day": "2026-08-02",
                "user_id": None,
                "alias": None,
                "requests": 2,
                "input_tokens": 30,
                "output_tokens": 15,
                "spend_micro_usd": 1000,
            },
            {
                "day": "2026-08-01",
                "user_id": None,
                "alias": None,
                "requests": 2,
                "input_tokens": 100,
                "output_tokens": 50,
                "spend_micro_usd": 400,
            },
        ]

    def test_self_top_models_order_by_spend(self, gateway_supabase: FakeSupabaseClient) -> None:
        """group_by=model returns the actor's aliases ordered by spend."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/daily",
            params={"org_id": ORG_ID, "group_by": "model"},
        )
        assert response.status_code == 200
        rows = response.json()["rows"]
        assert [(row["alias"], row["spend_micro_usd"]) for row in rows] == [
            ("claude-opus-5", 900),
            ("gpt-5", 500),
        ]

    def test_self_day_model_cells_newest_day_biggest_spender_first(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """group_by=day_model returns per-(day, alias) cells, both dims set."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/daily",
            params={"org_id": ORG_ID, "group_by": "day_model"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["group_by"] == "day_model"
        assert [
            (row["day"], row["alias"], row["requests"], row["spend_micro_usd"])
            for row in body["rows"]
        ] == [
            ("2026-08-02", "claude-opus-5", 1, 900),
            ("2026-08-02", "gpt-5", 1, 100),
            ("2026-08-01", "gpt-5", 2, 400),
        ]
        assert all(row["user_id"] is None for row in body["rows"])

    def test_org_member_breakdown_folds_unattributed(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """scope=org group_by=member covers every user, zero uuid as null."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/daily",
            params={"org_id": ORG_ID, "scope": "org", "group_by": "member"},
        )
        assert response.status_code == 200
        rows = response.json()["rows"]
        assert [(row["user_id"], row["spend_micro_usd"]) for row in rows] == [
            (ACTOR_ID, 1400),
            (USER_ID, 250),
            (None, 7),
        ]

    def test_window_filter_bounds_days(self, gateway_supabase: FakeSupabaseClient) -> None:
        """from/to bound the day range inclusively."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/daily",
            params={"org_id": ORG_ID, "from": "2026-08-02", "to": "2026-08-02"},
        )
        assert response.status_code == 200
        assert [row["day"] for row in response.json()["rows"]] == ["2026-08-02"]

    def test_malformed_date_is_400(self, gateway_supabase: FakeSupabaseClient) -> None:
        """A bad date fails at the boundary instead of reaching Postgres."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/daily",
            params={"org_id": ORG_ID, "from": "yesterday"},
        )
        assert response.status_code == 400

    def test_self_scope_rejects_conflicting_user(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """user_id under scope=self must match the actor."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/daily",
            params={"org_id": ORG_ID, "user_id": USER_ID},
        )
        assert response.status_code == 400

    def test_customer_key_reads_org_scope_only(self, gateway_supabase: FakeSupabaseClient) -> None:
        """A key actor has no self scope; scope=org serves its own org."""
        client = _customer_client(gateway_supabase)
        rejected = client.get("/api/gateway/usage/daily", params={"org_id": ORG_ID})
        assert rejected.status_code == 400
        allowed = client.get("/api/gateway/usage/daily", params={"org_id": ORG_ID, "scope": "org"})
        assert allowed.status_code == 200
        assert allowed.json()["rows"][0]["spend_micro_usd"] == 1257
        foreign = client.get(
            "/api/gateway/usage/daily",
            params={"org_id": OTHER_ORG_ID, "scope": "org"},
        )
        assert foreign.status_code == 404

    def test_outsider_gets_not_found(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Non-members cannot distinguish the org from an absent one."""
        response = _client(gateway_supabase, OUTSIDER_ID).get(
            "/api/gateway/usage/daily", params={"org_id": ORG_ID}
        )
        assert response.status_code == 404

    def test_platform_admin_reads_any_org(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Platform admins pass the org gate for operator reads."""
        response = _client(gateway_supabase, OPERATOR_ID).get(
            "/api/gateway/usage/daily",
            params={"org_id": OTHER_ORG_ID, "scope": "org"},
        )
        assert response.status_code == 200
        assert response.json()["rows"][0]["spend_micro_usd"] == 999


class TestUsagePlatformDaily:
    """GET /api/gateway/usage/platform-daily."""

    def test_day_series_sums_across_orgs(self, gateway_supabase: FakeSupabaseClient) -> None:
        """The platform series folds every org into per-day totals, newest first."""
        response = _client(gateway_supabase, OPERATOR_ID).get("/api/gateway/usage/platform-daily")
        assert response.status_code == 200
        body = response.json()
        assert body["group_by"] == "day"
        assert body["rows"] == [
            {
                "day": "2026-08-02",
                "org_id": None,
                "alias": None,
                "requests": 16,
                "input_tokens": 80,
                "output_tokens": 45,
                "spend_micro_usd": 2256,
            },
            {
                "day": "2026-08-01",
                "org_id": None,
                "alias": None,
                "requests": 2,
                "input_tokens": 100,
                "output_tokens": 50,
                "spend_micro_usd": 400,
            },
        ]

    def test_org_breakdown_orders_by_spend(self, gateway_supabase: FakeSupabaseClient) -> None:
        """group_by=org returns per-org totals ordered by spend."""
        response = _client(gateway_supabase, OPERATOR_ID).get(
            "/api/gateway/usage/platform-daily", params={"group_by": "org"}
        )
        assert response.status_code == 200
        rows = response.json()["rows"]
        assert [(row["org_id"], row["spend_micro_usd"]) for row in rows] == [
            (ORG_ID, 1657),
            (OTHER_ORG_ID, 999),
        ]

    def test_top_models_span_orgs(self, gateway_supabase: FakeSupabaseClient) -> None:
        """group_by=model sums an alias across every org before ranking."""
        response = _client(gateway_supabase, OPERATOR_ID).get(
            "/api/gateway/usage/platform-daily", params={"group_by": "model"}
        )
        assert response.status_code == 200
        rows = response.json()["rows"]
        assert [(row["alias"], row["spend_micro_usd"]) for row in rows] == [
            ("gpt-5", 1756),
            ("claude-opus-5", 900),
        ]

    def test_window_filter_bounds_days(self, gateway_supabase: FakeSupabaseClient) -> None:
        """from/to bound the day range inclusively."""
        response = _client(gateway_supabase, OPERATOR_ID).get(
            "/api/gateway/usage/platform-daily",
            params={"from": "2026-08-01", "to": "2026-08-01"},
        )
        assert response.status_code == 200
        assert [row["day"] for row in response.json()["rows"]] == ["2026-08-01"]

    def test_malformed_date_is_400(self, gateway_supabase: FakeSupabaseClient) -> None:
        """A bad date fails at the boundary instead of reaching Postgres."""
        response = _client(gateway_supabase, OPERATOR_ID).get(
            "/api/gateway/usage/platform-daily", params={"from": "yesterday"}
        )
        assert response.status_code == 400

    def test_member_gets_not_found(self, gateway_supabase: FakeSupabaseClient) -> None:
        """The operator read is not enumerable from a tenant session."""
        response = _client(gateway_supabase, ACTOR_ID).get("/api/gateway/usage/platform-daily")
        assert response.status_code == 404

    def test_customer_key_is_rejected_before_routing(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """The platform read is not on the customer-key surface."""
        response = _customer_client(gateway_supabase).get("/api/gateway/usage/platform-daily")
        assert response.status_code == 401


class TestUsageEvents:
    """GET /api/gateway/usage/events."""

    def test_keyset_pages_never_overlap(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Pages walk the stream newest-first without gaps or repeats."""
        client = _client(gateway_supabase, ACTOR_ID)
        first = client.get("/api/gateway/usage/events", params={"org_id": ORG_ID, "limit": 2})
        assert first.status_code == 200
        first_body = first.json()
        assert [event["request_id"] for event in first_body["events"]] == ["req-3", "req-2"]
        assert first_body["next_cursor"] is not None
        second = client.get(
            "/api/gateway/usage/events",
            params={"org_id": ORG_ID, "limit": 2, "cursor": first_body["next_cursor"]},
        )
        assert second.status_code == 200
        second_body = second.json()
        assert [event["request_id"] for event in second_body["events"]] == ["req-1"]
        assert second_body["next_cursor"] is None

    def test_event_exposes_charged_and_estimated_money(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """Charged and never-charged money ride separate fields."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/events", params={"org_id": ORG_ID}
        )
        assert response.status_code == 200
        by_id = {event["request_id"]: event for event in response.json()["events"]}
        assert by_id["req-1"]["cost_micro_usd"] == 100
        assert by_id["req-1"]["estimated_cost_micro_usd"] == 0
        assert by_id["req-2"]["cost_micro_usd"] == 0
        assert by_id["req-2"]["estimated_cost_micro_usd"] == 55
        assert by_id["req-2"]["lane"] == "pass_through"

    def test_key_filter_scopes_to_one_key(self, gateway_supabase: FakeSupabaseClient) -> None:
        """api_key_id narrows the stream to one key's requests."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/events",
            params={"org_id": ORG_ID, "api_key_id": ORG_KEY_ID},
        )
        assert response.status_code == 200
        assert [event["request_id"] for event in response.json()["events"]] == [
            "req-2",
            "req-1",
        ]

    def test_invalid_cursor_is_400(self, gateway_supabase: FakeSupabaseClient) -> None:
        """A malformed cursor is rejected at the boundary."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/usage/events",
            params={"org_id": ORG_ID, "cursor": "not-a-cursor"},
        )
        assert response.status_code == 400

    def test_customer_key_sees_only_its_org(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Key-authenticated reads stay inside the key's organization."""
        client = _customer_client(gateway_supabase)
        own = client.get("/api/gateway/usage/events", params={"org_id": ORG_ID})
        assert own.status_code == 200
        assert {event["request_id"] for event in own.json()["events"]} == {
            "req-1",
            "req-2",
            "req-3",
        }
        foreign = client.get("/api/gateway/usage/events", params={"org_id": OTHER_ORG_ID})
        assert foreign.status_code == 404


class TestKeyLimits:
    """GET and PUT /api/gateway/keys/{api_key_id}/limits."""

    def test_defaults_for_free_credit_org(self, gateway_supabase: FakeSupabaseClient) -> None:
        """No row on a free-credit org: rpm 60 and the $50/day cap."""
        response = _client(gateway_supabase, ACTOR_ID).get(f"/api/gateway/keys/{ORG_KEY_ID}/limits")
        assert response.status_code == 200
        assert response.json() == {
            "api_key_id": ORG_KEY_ID,
            "daily_spend_cap_micro_usd": 50_000_000,
            "requests_per_minute": 60,
            "tokens_per_minute": None,
            "source": "default",
        }

    def test_defaults_for_paid_org_drop_the_cap(self, gateway_supabase: FakeSupabaseClient) -> None:
        """A paid (Stripe) org defaults to no daily cap."""
        gateway_supabase.tables["credit_ledger"] = [
            {"id": "ledger-1", "org_id": ORG_ID, "source": "stripe", "amount_usd": 100.0},
        ]
        response = _client(gateway_supabase, ACTOR_ID).get(f"/api/gateway/keys/{ORG_KEY_ID}/limits")
        assert response.status_code == 200
        body = response.json()
        assert body["daily_spend_cap_micro_usd"] is None
        assert body["requests_per_minute"] == 60
        assert body["source"] == "default"

    def test_put_replaces_the_whole_row(self, gateway_supabase: FakeSupabaseClient) -> None:
        """PUT persists exactly the body; omitted fields become uncapped."""
        client = _client(gateway_supabase, ACTOR_ID)
        first = client.put(
            f"/api/gateway/keys/{ORG_KEY_ID}/limits",
            json={
                "daily_spend_cap_micro_usd": 1_000_000,
                "requests_per_minute": 5,
                "tokens_per_minute": 90_000,
            },
        )
        assert first.status_code == 200
        assert first.json() == {
            "api_key_id": ORG_KEY_ID,
            "daily_spend_cap_micro_usd": 1_000_000,
            "requests_per_minute": 5,
            "tokens_per_minute": 90_000,
            "source": "explicit",
        }
        read_back = client.get(f"/api/gateway/keys/{ORG_KEY_ID}/limits")
        assert read_back.json()["source"] == "explicit"
        assert read_back.json()["requests_per_minute"] == 5
        second = client.put(
            f"/api/gateway/keys/{ORG_KEY_ID}/limits",
            json={"requests_per_minute": 10},
        )
        assert second.status_code == 200
        assert second.json()["daily_spend_cap_micro_usd"] is None
        assert second.json()["requests_per_minute"] == 10
        # Full-resource semantics extend to the new knob: omitting
        # tokens_per_minute uncaps it.
        assert second.json()["tokens_per_minute"] is None

    def test_put_requires_org_admin(self, gateway_supabase: FakeSupabaseClient) -> None:
        """A user-role member cannot arm spend controls."""
        response = _client(gateway_supabase, USER_ID).put(
            f"/api/gateway/keys/{ORG_KEY_ID}/limits",
            json={"requests_per_minute": 10},
        )
        assert response.status_code == 403

    def test_put_rejects_negative_cap(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Validation stops nonsense before it reaches the table."""
        response = _client(gateway_supabase, ACTOR_ID).put(
            f"/api/gateway/keys/{ORG_KEY_ID}/limits",
            json={"daily_spend_cap_micro_usd": -1},
        )
        assert response.status_code == 422

    def test_customer_key_reads_but_never_writes(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """Keys self-serve the read; the write is not on their surface."""
        client = _customer_client(gateway_supabase)
        read = client.get(f"/api/gateway/keys/{ORG_KEY_ID}/limits")
        assert read.status_code == 200
        # PUT is not allowlisted for customer keys: rejected before routing.
        write = client.put(
            f"/api/gateway/keys/{ORG_KEY_ID}/limits",
            json={"requests_per_minute": 10},
        )
        assert write.status_code == 401
        foreign = client.get("/api/gateway/keys/key-org2/limits")
        assert foreign.status_code == 404

    def test_unknown_key_is_not_found(self, gateway_supabase: FakeSupabaseClient) -> None:
        """An absent key id 404s with the standard message."""
        response = _client(gateway_supabase, ACTOR_ID).get("/api/gateway/keys/key-missing/limits")
        assert response.status_code == 404


class TestWorkers:
    """GET /api/gateway/workers."""

    def test_platform_admin_sees_staleness(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Workers list carries the derived 60s staleness flag."""
        response = _client(gateway_supabase, OPERATOR_ID).get("/api/gateway/workers")
        assert response.status_code == 200
        workers = {worker["worker_id"]: worker for worker in response.json()["workers"]}
        assert workers["worker-fresh"]["stale"] is False
        assert workers["worker-stale"]["stale"] is True

    def test_members_get_not_found(self, gateway_supabase: FakeSupabaseClient) -> None:
        """The operator panel is not enumerable from a tenant session."""
        response = _client(gateway_supabase, ACTOR_ID).get("/api/gateway/workers")
        assert response.status_code == 404

    def test_customer_key_is_rejected_before_routing(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """The workers route is not on the customer-key surface."""
        response = _customer_client(gateway_supabase).get("/api/gateway/workers")
        assert response.status_code == 401


class TestCatalog:
    """GET /api/gateway/catalog."""

    def test_org_view_applies_shadowing_and_lanes(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """Org-1 sees public models, its shadow winning, and BYOK lanes."""
        response = _client(gateway_supabase, ACTOR_ID).get(
            "/api/gateway/catalog", params={"org_id": ORG_ID}
        )
        assert response.status_code == 200
        body = response.json()
        by_alias = {alias["alias"]: alias for alias in body["aliases"]}
        assert set(by_alias) == {"gpt-5", "shadow-me"}
        public = by_alias["gpt-5"]
        assert public["custom"] is False
        assert public["revision_id"] == "rev-public-gpt5"
        # Org-1 holds an anthropic BYOK connection; openai rides platform credits.
        assert public["providers"] == [
            {"provider": "openai", "lane": "platform_funded"},
            {"provider": "anthropic", "lane": "pass_through"},
        ]
        shadow = by_alias["shadow-me"]
        assert shadow["custom"] is True
        assert shadow["revision_id"] == "rev-org1-shadow"
        # The org alias routes a customer-managed deployment: pass-through.
        assert shadow["providers"] == [{"provider": "openai", "lane": "pass_through"}]

    def test_other_org_sees_public_and_its_own(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Org-2 gets the unshadowed public alias plus its custom model."""
        response = _client(gateway_supabase, OPERATOR_ID).get(
            "/api/gateway/catalog", params={"org_id": OTHER_ORG_ID}
        )
        assert response.status_code == 200
        by_alias = {alias["alias"]: alias for alias in response.json()["aliases"]}
        assert set(by_alias) == {"gpt-5", "org2-model", "shadow-me"}
        assert by_alias["shadow-me"]["custom"] is False
        assert by_alias["shadow-me"]["revision_id"] == "rev-public-shadowed"
        # No BYOK connections: everything is platform-funded.
        assert by_alias["gpt-5"]["providers"] == [
            {"provider": "openai", "lane": "platform_funded"},
            {"provider": "anthropic", "lane": "platform_funded"},
        ]

    def test_outsider_gets_not_found(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Catalog reads are tenant-gated like every other org read."""
        response = _client(gateway_supabase, OUTSIDER_ID).get(
            "/api/gateway/catalog", params={"org_id": ORG_ID}
        )
        assert response.status_code == 404

    def test_customer_key_reads_its_org_catalog(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Keys resolve the same catalog their traffic routes against."""
        response = _customer_client(gateway_supabase).get(
            "/api/gateway/catalog", params={"org_id": ORG_ID}
        )
        assert response.status_code == 200
        assert {alias["alias"] for alias in response.json()["aliases"]} == {
            "gpt-5",
            "shadow-me",
        }


class TestWhoami:
    """GET /api/whoami."""

    def test_customer_key_resolves_its_org(self, gateway_supabase: FakeSupabaseClient) -> None:
        """An xpl_ key answers with exactly the org it acts for."""
        response = _customer_client(gateway_supabase).get("/api/whoami")
        assert response.status_code == 200
        assert response.json() == {
            "org_id": ORG_ID,
            "org_slug": "experiential-labs",
            "org_name": "Experiential Labs",
        }

    def test_bad_or_absent_key_is_401(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Unknown bearers and anonymous callers die at the middleware."""
        app = create_app(client=gateway_supabase)
        bad_key = TestClient(app, headers={"Authorization": "Bearer xpl_not_a_real_key"})
        assert bad_key.get("/api/whoami").status_code == 401
        anonymous = TestClient(app)
        assert anonymous.get("/api/whoami").status_code == 401

    def test_session_actor_resolves_sole_membership(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """A single-org session actor gets their org."""
        response = _client(gateway_supabase, USER_ID).get("/api/whoami")
        assert response.status_code == 200
        assert response.json()["org_id"] == ORG_ID

    def test_multi_org_actor_gets_409(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Several memberships have no single answer; the 409 names the fix."""
        gateway_supabase.tables["organization_members"].append(
            {"org_id": OTHER_ORG_ID, "user_id": USER_ID, "role": "user"}
        )
        response = _client(gateway_supabase, USER_ID).get("/api/whoami")
        assert response.status_code == 409

    def test_platform_admin_gets_409(self, gateway_supabase: FakeSupabaseClient) -> None:
        """Admins act across every org, so whoami cannot pick one."""
        response = _client(gateway_supabase, OPERATOR_ID).get("/api/whoami")
        assert response.status_code == 409

    def test_membership_less_actor_gets_404(self, gateway_supabase: FakeSupabaseClient) -> None:
        """No membership means no acting org."""
        response = _client(gateway_supabase, OUTSIDER_ID).get("/api/whoami")
        assert response.status_code == 404


class TestCustomerKeyAllowlist:
    """The Contract 3 management surface for org API keys."""

    def test_flagged_management_routes_pass_the_middleware(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """Routes flagged by keys-P5 and core-P8 clear auth (404: no route here).

        Those workstreams ship the handlers on their branches; the allowlist
        entries land here so a management-scope key stops being rejected at
        the door. 404-not-401 proves middleware passage.
        """
        client = _customer_client(gateway_supabase)
        calls = (
            ("GET", "/api/keys"),
            ("GET", f"/api/orgs/{ORG_ID}/provider-connections"),
            ("PUT", f"/api/orgs/{ORG_ID}/provider-connections/openai"),
            ("POST", f"/api/orgs/{ORG_ID}/provider-connections/openai/check"),
            ("POST", f"/api/orgs/{ORG_ID}/provider-connections/openai/spend-refresh"),
            ("GET", "/api/models"),
            ("POST", "/api/models"),
            ("GET", "/api/models/some-slug"),
            ("GET", "/api/models/some-slug/providers"),
            ("POST", "/api/models/some-slug/providers"),
            ("GET", "/api/models/some-slug/waterfall"),
            ("PUT", "/api/models/some-slug/waterfall"),
        )
        for method, path in calls:
            response = client.request(method, path, json={} if method != "GET" else None)
            # Passing the middleware means not a 401: the route runs and answers
            # on its own terms (404 for a missing resource, 422 when an empty
            # body fails the route's own validation, 200 once its handler ships)
            # rather than being refused at the door.
            assert response.status_code != 401, (method, path)

    def test_unflagged_mutations_stay_off_the_key_surface(
        self, gateway_supabase: FakeSupabaseClient
    ) -> None:
        """Mutations outside the flagged surface still die at the middleware."""
        client = _customer_client(gateway_supabase)
        assert client.post("/api/keys", json={}).status_code == 401
        assert client.delete("/api/models").status_code == 401
        # The detail entry is GET-only and must not widen into writes.
        assert client.put("/api/models/some-slug", json={}).status_code == 401
        # Connection writes admit exactly PUT + the two POST actions; a
        # delete (disconnect) stays deployment-key-only.
        delete = client.delete(f"/api/orgs/{ORG_ID}/provider-connections/openai")
        assert delete.status_code == 401


# ---------------------------------------------------------------------------
# Real-Postgres integration: read RPC correctness and the Overview
# performance bar. Requires SUPABASE_DB_URL (compose stack).

_IORG = "ee000000-0000-0000-0000-000000000501"
_IUSER_A = "ee000000-0000-0000-0000-000000000511"
_IUSER_B = "ee000000-0000-0000-0000-000000000512"
_IKEY_A1 = "ee000000-0000-0000-0000-000000000521"
_IKEY_A2 = "ee000000-0000-0000-0000-000000000522"
_IKEY_B1 = "ee000000-0000-0000-0000-000000000523"
_IALIASES = ("gpt-5", "claude-opus-5", "qwen3.5-9b")
_IDAYS = 90
_IEVENTS = 120


def _database_url() -> str:
    """Return the disposable integration database URL or skip."""
    value = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not value:
        pytest.skip("SUPABASE_DB_URL is required for integration tests")
    return value


@pytest.fixture(name="gateway_pg")
def gateway_pg_fixture() -> Iterator[Connection[tuple[object, ...]]]:
    """Autocommit connection with the 90-day usage fixture seeded.

    Rows are inserted directly rather than through the settlement functions:
    this fixture exists to exercise the READ paths and their indexes at
    volume; the sanctioned write paths are pinned by the pgTAP suite.
    """
    connection = psycopg.connect(_database_url(), autocommit=True)
    _cleanup_integration_rows(connection)
    _seed_integration_rows(connection)
    try:
        yield connection
    finally:
        _cleanup_integration_rows(connection)
        connection.close()


def _cleanup_integration_rows(connection: Connection[tuple[object, ...]]) -> None:
    """Remove the isolated fixture, disarming the append-only triggers."""
    connection.execute("set session_replication_role = replica")
    try:
        for table, column in (
            ("gateway_usage_events", "org_id"),
            ("gateway_usage_daily", "org_id"),
            ("gateway_requests", "org_id"),
            ("gateway_key_limits", "api_key_id"),
            ("api_keys", "org_id"),
            ("organizations", "id"),
        ):
            value = _IKEY_A1 if column == "api_key_id" else _IORG
            connection.execute(
                f"delete from public.{table} where {column} = %s",
                (value,),
            )
    finally:
        connection.execute("set session_replication_role = origin")


def _seed_integration_rows(connection: Connection[tuple[object, ...]]) -> None:
    """Seed one org, two users, three keys, 90 days of rollup, 120 events."""
    connection.execute(
        """
        insert into public.organizations (
          id, slug, name, credit_granted_usd, spend_usd, billable_spend_usd
        ) values (%s, 'gw-int-p5-reads', 'GW Int P5 Reads', 20, 0, 0)
        """,
        (_IORG,),
    )
    for key_id, user_id, suffix in (
        (_IKEY_A1, _IUSER_A, "a1"),
        (_IKEY_A2, _IUSER_A, "a2"),
        (_IKEY_B1, _IUSER_B, "b1"),
    ):
        connection.execute(
            """
            insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by)
            values (%s, %s, %s, %s, %s, %s)
            """,
            (key_id, _IORG, f"reads-{suffix}", f"xpl_{suffix}", f"{suffix:0>1}" * 32, user_id),
        )
    base_day = date(2026, 5, 1)
    daily_rows = []
    for offset in range(_IDAYS):
        day = base_day + timedelta(days=offset)
        for user_index, user_id in enumerate((_IUSER_A, _IUSER_B)):
            for alias_index, alias in enumerate(_IALIASES):
                daily_rows.append(
                    (
                        _IORG,
                        user_id,
                        day,
                        alias,
                        1 + alias_index,
                        100 + offset,
                        50 + offset,
                        (offset + 1) * (alias_index + 1) * (user_index + 1),
                    )
                )
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            insert into public.gateway_usage_daily (
              org_id, user_id, day, alias, requests,
              input_tokens, output_tokens, spend_micro_usd
            ) values (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            daily_rows,
        )
    request_rows = []
    event_rows = []
    for index in range(_IEVENTS):
        request_id = f"req-int-p5-{index:04d}"
        day = base_day + timedelta(days=index % _IDAYS)
        created = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC) + timedelta(
            days=index % _IDAYS, seconds=index
        )
        key_id = (_IKEY_A1, _IKEY_A2, _IKEY_B1)[index % 3]
        request_rows.append(
            (
                request_id,
                _IORG,
                key_id,
                _IALIASES[index % 3],
                "rev-int-p5",
                "chat_completions",
                "c" * 64,
                created,
                created + timedelta(seconds=120),
                "completed",
                created + timedelta(seconds=1),
            )
        )
        event_rows.append(
            (
                request_id,
                _IORG,
                key_id,
                (_IUSER_A, _IUSER_A, _IUSER_B)[index % 3],
                _IALIASES[index % 3],
                "openai",
                "platform_funded",
                10,
                5,
                index,
                0,
                100,
                "completed",
                1,
                day,
                created,
            )
        )
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            insert into public.gateway_requests (
              request_id, org_id, api_key_id, alias, alias_revision_id,
              api_surface, canonical_request_sha256, accepted_at, deadline_at,
              terminal_state, terminal_at
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            request_rows,
        )
        cursor.executemany(
            """
            insert into public.gateway_usage_events (
              request_id, org_id, api_key_id, user_id, alias, provider, lane,
              input_tokens, output_tokens, cost_micro_usd,
              estimated_cost_micro_usd, latency_ms, status, attempt_count,
              day, created_at
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            event_rows,
        )


@pytest.mark.integration
def test_integration_daily_rollup_shapes_and_sums(
    gateway_pg: Connection[tuple[object, ...]],
) -> None:
    """The rollup RPC returns per-user day series and top models exactly."""
    day_rows = gateway_pg.execute(
        "select * from public.gateway_usage_daily_read(%s, %s, null, null, 'day', 2000)",
        (_IORG, _IUSER_A),
    ).fetchall()
    assert len(day_rows) == _IDAYS
    # Newest first; day 90 (offset 89) sums the three aliases for user A.
    newest = day_rows[0]
    assert str(newest[0]) == "2026-07-29"
    assert newest[3] == 1 + 2 + 3
    assert newest[6] == 90 * 1 + 90 * 2 + 90 * 3
    model_rows = gateway_pg.execute(
        "select * from public.gateway_usage_daily_read(%s, %s, null, null, 'model', 2000)",
        (_IORG, _IUSER_A),
    ).fetchall()
    assert [row[2] for row in model_rows] == ["qwen3.5-9b", "claude-opus-5", "gpt-5"]
    total_days = _IDAYS * (_IDAYS + 1) // 2
    assert [row[6] for row in model_rows] == [3 * total_days, 2 * total_days, total_days]


@pytest.mark.integration
def test_integration_platform_rollup_matches_direct_aggregate(
    gateway_pg: Connection[tuple[object, ...]],
) -> None:
    """The platform RPC equals a direct cross-org aggregate of the rollup.

    The shared integration database may carry rows from other suites, so the
    day series is pinned against an aggregate computed in the same
    transaction rather than against fixture-only constants; the seeded org's
    exact total pins the org grouping.
    """
    expected = gateway_pg.execute(
        """
        select daily.day, sum(daily.requests)::int8, sum(daily.spend_micro_usd)::int8
          from public.gateway_usage_daily daily
         group by daily.day
         order by daily.day desc
         limit 2000
        """
    ).fetchall()
    day_rows = gateway_pg.execute(
        "select * from public.gateway_usage_platform_read(null, null, 'day', 2000)"
    ).fetchall()
    assert [(row[0], row[3], row[6]) for row in day_rows] == [tuple(row) for row in expected]
    org_rows = gateway_pg.execute(
        "select * from public.gateway_usage_platform_read(null, null, 'org', 2000)"
    ).fetchall()
    # Sum over 90 days x 2 users x 3 aliases of (offset+1)(alias+1)(user+1)
    # factors into (90*91/2) * (1+2+3) * (1+2).
    assert (_IORG, 90 * 91 // 2 * 6 * 3) in [(str(row[1]), row[6]) for row in org_rows]


@pytest.mark.integration
def test_integration_overview_rollup_is_fast(gateway_pg: Connection[tuple[object, ...]]) -> None:
    """The Overview query answers all-time in one indexed pass under 50ms."""
    plan_row = gateway_pg.execute(
        """
        explain (analyze, format json)
        select daily.day,
               sum(daily.requests), sum(daily.input_tokens),
               sum(daily.output_tokens), sum(daily.spend_micro_usd)
          from public.gateway_usage_daily daily
         where daily.org_id = %s and daily.user_id = %s
         group by daily.day
         order by daily.day desc
        """,
        (_IORG, _IUSER_A),
    ).fetchone()
    assert plan_row is not None
    raw_plan = plan_row[0]
    assert isinstance(raw_plan, list)
    plan = raw_plan[0]
    assert isinstance(plan, dict)
    execution_ms = {str(key): value for key, value in plan.items()}["Execution Time"]
    assert isinstance(execution_ms, (int, float))
    assert execution_ms < 50.0


@pytest.mark.integration
def test_integration_events_keyset_walk_is_exact(
    gateway_pg: Connection[tuple[object, ...]],
) -> None:
    """Cursor pages partition the stream: no gaps, no repeats, exact order."""
    full = gateway_pg.execute(
        "select request_id from public.gateway_usage_events_read"
        "(%s, null, null, null, null, null, null, 200)",
        (_IORG,),
    ).fetchall()
    assert len(full) == _IEVENTS
    walked: list[str] = []
    cursor: tuple[object, object, object] = (None, None, None)
    while True:
        page = gateway_pg.execute(
            "select request_id, day, created_at from public.gateway_usage_events_read"
            "(%s, null, null, null, %s, %s, %s, 37)",
            (_IORG, *cursor),
        ).fetchall()
        walked.extend(str(row[0]) for row in page)
        if len(page) < 37:
            break
        last = page[-1]
        cursor = (last[1], last[2], last[0])
    assert walked == [str(row[0]) for row in full]


@pytest.mark.integration
def test_integration_key_limits_effective_lockstep(
    gateway_pg: Connection[tuple[object, ...]],
) -> None:
    """Defaults match gateway_start_attempt's arms; explicit rows win."""
    default = gateway_pg.execute(
        "select api_key_id::text, daily_spend_cap_micro_usd, requests_per_minute, source"
        " from public.gateway_key_limits_effective(%s)",
        (_IKEY_A1,),
    ).fetchone()
    assert default == (_IKEY_A1, 50_000_000, 60, "default")
    # gateway_key_limits is the control API's direct-write table.
    gateway_pg.execute(
        """
        insert into public.gateway_key_limits (
          api_key_id, daily_spend_cap_micro_usd, requests_per_minute
        ) values (%s, null, 5)
        """,
        (_IKEY_A1,),
    )
    explicit = gateway_pg.execute(
        "select api_key_id::text, daily_spend_cap_micro_usd, requests_per_minute, source"
        " from public.gateway_key_limits_effective(%s)",
        (_IKEY_A1,),
    ).fetchone()
    assert explicit == (_IKEY_A1, None, 5, "explicit")


def test_key_limits_put_emits_an_audit_event(gateway_supabase: FakeSupabaseClient) -> None:
    """The key-limits spend control write is followed by one audit emit."""
    response = _client(gateway_supabase, ACTOR_ID).put(
        f"/api/gateway/keys/{ORG_KEY_ID}/limits",
        json={"requests_per_minute": 9},
    )
    assert response.status_code == 200
    assert gateway_supabase.executed_rpcs.count("record_audit_event") == 1
