# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Shared fixtures for platform API tests.

Provides a seeded fake Supabase client plus a stub registry injected through
``create_app`` overrides, so route tests exercise the full HTTP surface
without loading real world models.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import JsonObject
from explabs.db.stores.api_key_store import hash_api_key

TEST_API_KEY = "test-api-key"

READY_WM_ID = "wm-ready"
READY_WM_ARTIFACT_ID = "artifact-ready"
CREATED_WM_ID = "wm-created"
ORG_ID = "org-1"

# Shared world-model catalog entries: one live and importable, one deprecated
# (closed to imports, hidden from listing).
CATALOG_ENTRY_ID = "catalog-entry-live"
DEPRECATED_ENTRY_ID = "catalog-entry-deprecated"

# Seeded actors, one per role tier. ACTOR_ID (an org admin) is the default
# test client's actor so ordinary route tests pass every role gate through a
# real membership row rather than the platform-admin bypass.
ACTOR_ID = "user-org-admin"
USER_ID = "user-standard"
OUTSIDER_ID = "user-outsider"
OPERATOR_ID = "user-platform-admin"
# A platform admin whose ACCOUNT is banned: still in platform_admins, but the
# ban makes every credential of theirs dead.
BANNED_OPERATOR_ID = "user-banned-platform-admin"

# A second org with its own world model and session, plus customer API keys
# for both orgs: cross-org scoping tests need a resource the org-1 key must
# not reach.
OTHER_ORG_ID = "org-2"
OTHER_ORG_WM_ID = "wm-other-org"
OTHER_ORG_SESSION_ID = "session-other-org"
CUSTOMER_KEY_SECRET = "xpl_test_customer_secret_org1"
# Superadmin (operator) machine credentials: a live key owned by the platform
# admin, a revoked one, a live-but-orphaned one whose owner is NOT in
# platform_admins, and one owned by a BANNED operator (all three dead).
SUPERADMIN_KEY_SECRET = "xpladmin_test_operator_secret"
SUPERADMIN_KEY_ID = "sakey-operator"
REVOKED_SUPERADMIN_KEY_SECRET = "xpladmin_test_revoked_secret"
ORPHAN_SUPERADMIN_KEY_SECRET = "xpladmin_test_orphan_secret"
# An unrevoked key whose owner is banned: the ban transaction revokes such
# keys, so this row models a ban applied before that revocation existed (or
# any hand-edited state) and pins the auth-time ban check.
BANNED_SUPERADMIN_KEY_SECRET = "xpladmin_test_banned_owner_secret"
# The fixture api_keys row's id; tests asserting key-actor attribution use it.
ORG_KEY_ID = "key-org1"
OTHER_ORG_KEY_SECRET = "xpl_test_customer_secret_org2"
REVOKED_KEY_SECRET = "xpl_test_revoked_secret"
EXPIRED_KEY_SECRET = "xpl_test_expired_secret"


@pytest.fixture(autouse=True)
def _api_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure API auth for tests by default."""
    monkeypatch.setenv("EXPLABS_API_KEY", TEST_API_KEY)


def world_model_row(
    *,
    world_model_id: str,
    name: str,
    status: str,
    artifact_id: str | None,
    metrics: JsonObject | None,
    created_at: str,
) -> JsonObject:
    """Build one seeded ``world_models`` row."""
    return {
        "id": world_model_id,
        "org_id": ORG_ID,
        "name": name,
        "display_name": name.replace("-", " ").title(),
        "status": status,
        "serve_provider": "anthropic",
        "serve_model": "claude-sonnet-4-5",
        "embed_provider": None,
        "embed_dim": None,
        "gepa_budget": None,
        "trace_adapter": "otel-genai",
        "config": {},
        "artifact_id": artifact_id,
        "catalog_entry_id": None,
        "metrics": metrics,
        "error": None,
        "created_at": created_at,
        "updated_at": created_at,
    }


def catalog_entry_row(
    *,
    entry_id: str,
    name: str,
    deprecated_at: str | None = None,
    serve_provider: str = "anthropic",
) -> JsonObject:
    """Build one seeded ``wm_catalog_entries`` row."""
    return {
        "id": entry_id,
        "name": name,
        "display_name": name.replace("-", " ").title(),
        "description": f"Example {name} world model.",
        "serve_provider": serve_provider,
        "serve_model": "claude-sonnet-4-5",
        "embed_provider": "hashing",
        "embed_dim": 512,
        "trace_adapter": "otel-genai",
        "config": {"top_k": 5},
        "metrics": {"accuracy": 0.9},
        "trace_count": 12,
        "step_count": 134,
        "storage_bucket": "explabs-artifacts",
        "storage_path": f"catalog/{entry_id}/{'b' * 64}.tar.gz",
        "byte_size": 4096,
        "sha256": "b" * 64,
        "import_count": 0,
        "traces_filename": f"{name}.otel.jsonl",
        "traces_storage_path": f"catalog/{entry_id}/traces/{'c' * 64}.otel.jsonl",
        "traces_byte_size": 2048,
        "traces_sha256": "c" * 64,
        "source_world_model_id": None,
        "deprecated_at": deprecated_at,
        "created_at": "2026-06-05T00:00:00Z",
    }


@pytest.fixture
def supabase() -> FakeSupabaseClient:
    """Fake Supabase client seeded with orgs and world models."""
    client = FakeSupabaseClient()
    client.tables["organizations"] = [
        {
            "id": ORG_ID,
            "slug": "experiential-labs",
            "name": "Experiential Labs",
            # Mirrors the post-signup-trigger state: the welcome grant is on
            # the counter, so the credit gate admits traffic by default.
            "credit_granted_usd": 20.0,
            "spend_usd": 0.0,
            "billable_spend_usd": 0.0,
            "free_credit_caps_lifted_at": None,
            "gateway_unknown_cost_attempts": 0,
            "created_at": "2026-06-01T00:00:00Z",
        },
    ]
    client.tables["organization_members"] = [
        {"org_id": ORG_ID, "user_id": ACTOR_ID, "role": "admin"},
        {"org_id": ORG_ID, "user_id": USER_ID, "role": "user"},
    ]
    client.tables["platform_admins"] = [
        {"user_id": OPERATOR_ID},
        {"user_id": BANNED_OPERATOR_ID},
    ]
    client.tables["user_bans"] = [
        {
            "user_id": BANNED_OPERATOR_ID,
            "reason": "Credential misuse",
            "banned_by": OPERATOR_ID,
            "banned_at": "2026-06-09T00:00:00Z",
        },
    ]
    client.tables["platform_admin_keys"] = [
        {
            "id": SUPERADMIN_KEY_ID,
            "user_id": OPERATOR_ID,
            "owner_email": "operator@explabs.example",
            "name": "operator automation",
            "key_prefix": SUPERADMIN_KEY_SECRET[:13],
            "key_suffix": SUPERADMIN_KEY_SECRET[-4:],
            "key_hash": hash_api_key(SUPERADMIN_KEY_SECRET),
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
        },
        {
            "id": "sakey-revoked",
            "user_id": OPERATOR_ID,
            "owner_email": "operator@explabs.example",
            "name": "revoked automation",
            "key_prefix": REVOKED_SUPERADMIN_KEY_SECRET[:13],
            "key_suffix": REVOKED_SUPERADMIN_KEY_SECRET[-4:],
            "key_hash": hash_api_key(REVOKED_SUPERADMIN_KEY_SECRET),
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": "2026-06-08T00:00:00Z",
        },
        {
            "id": "sakey-banned-owner",
            "user_id": BANNED_OPERATOR_ID,
            "owner_email": "banned-operator@explabs.example",
            "name": "banned operator automation",
            "key_prefix": BANNED_SUPERADMIN_KEY_SECRET[:13],
            "key_suffix": BANNED_SUPERADMIN_KEY_SECRET[-4:],
            "key_hash": hash_api_key(BANNED_SUPERADMIN_KEY_SECRET),
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
        },
        {
            "id": "sakey-orphan",
            "user_id": OUTSIDER_ID,
            "owner_email": "outsider@explabs.example",
            "name": "owner lost operator status",
            "key_prefix": ORPHAN_SUPERADMIN_KEY_SECRET[:13],
            "key_suffix": ORPHAN_SUPERADMIN_KEY_SECRET[-4:],
            "key_hash": hash_api_key(ORPHAN_SUPERADMIN_KEY_SECRET),
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
        },
    ]
    client.tables["world_models"] = [
        world_model_row(
            world_model_id=READY_WM_ID,
            name="tau-bench",
            status="ready",
            artifact_id=READY_WM_ARTIFACT_ID,
            metrics={"accuracy": 0.8},
            created_at="2026-06-03T00:00:00Z",
        ),
        world_model_row(
            world_model_id=CREATED_WM_ID,
            name="terminal-tasks",
            status="created",
            artifact_id=None,
            metrics=None,
            created_at="2026-06-04T00:00:00Z",
        ),
    ]
    client.tables["organizations"].append(
        {
            "id": OTHER_ORG_ID,
            "slug": "other-org",
            "name": "Other Org",
            "credit_granted_usd": 20.0,
            "spend_usd": 0.0,
            "billable_spend_usd": 0.0,
            "free_credit_caps_lifted_at": None,
            "gateway_unknown_cost_attempts": 0,
            "created_at": "2026-06-01T00:00:00Z",
        }
    )
    other_org_model = world_model_row(
        world_model_id=OTHER_ORG_WM_ID,
        name="other-org-model",
        status="ready",
        artifact_id=None,
        metrics=None,
        created_at="2026-06-05T00:00:00Z",
    )
    other_org_model["org_id"] = OTHER_ORG_ID
    client.tables["world_models"].append(other_org_model)
    client.tables["wm_sessions"] = [
        {
            "id": OTHER_ORG_SESSION_ID,
            "org_id": OTHER_ORG_ID,
            "world_model_id": OTHER_ORG_WM_ID,
            "wmh_session_id": "wmo-other",
            "task": None,
            "seed_state": None,
            "status": "active",
            "step_count": 0,
            "usage": None,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": None,
            "created_at": "2026-06-06T00:00:00Z",
            "last_step_at": None,
        },
    ]
    client.tables["wm_catalog_entries"] = [
        catalog_entry_row(entry_id=CATALOG_ENTRY_ID, name="catalog-demo"),
        catalog_entry_row(
            entry_id=DEPRECATED_ENTRY_ID,
            name="catalog-retired",
            deprecated_at="2026-06-06T00:00:00Z",
        ),
    ]
    client.tables["api_keys"] = [
        {
            "id": ORG_KEY_ID,
            "org_id": ORG_ID,
            "name": "org-1 test key",
            "key_prefix": CUSTOMER_KEY_SECRET[:12],
            "key_suffix": CUSTOMER_KEY_SECRET[-4:],
            "key_hash": hash_api_key(CUSTOMER_KEY_SECRET),
            "created_by": None,
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            # Far-future expiry: the org-1 key exercises the "set but not yet
            # passed" branch on every authenticated test.
            "expires_at": "2126-01-01T00:00:00+00:00",
        },
        {
            "id": "key-org2",
            "org_id": OTHER_ORG_ID,
            "name": "org-2 test key",
            "key_prefix": OTHER_ORG_KEY_SECRET[:12],
            "key_suffix": OTHER_ORG_KEY_SECRET[-4:],
            "key_hash": hash_api_key(OTHER_ORG_KEY_SECRET),
            "created_by": None,
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            "expires_at": None,
        },
        {
            "id": "key-revoked",
            "org_id": ORG_ID,
            "name": "revoked key",
            "key_prefix": REVOKED_KEY_SECRET[:12],
            "key_suffix": REVOKED_KEY_SECRET[-4:],
            "key_hash": hash_api_key(REVOKED_KEY_SECRET),
            "created_by": None,
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": "2026-06-08T00:00:00Z",
            "expires_at": None,
        },
        {
            "id": "key-expired",
            "org_id": ORG_ID,
            "name": "expired key",
            "key_prefix": EXPIRED_KEY_SECRET[:12],
            "key_suffix": EXPIRED_KEY_SECRET[-4:],
            "key_hash": hash_api_key(EXPIRED_KEY_SECRET),
            "created_by": None,
            "created_at": "2026-06-07T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            "expires_at": "2026-06-09T00:00:00+00:00",
        },
    ]
    client.tables["artifacts"] = [
        {
            "id": READY_WM_ARTIFACT_ID,
            "org_id": ORG_ID,
            "world_model_id": READY_WM_ID,
            "kind": "world_model_bundle",
            "storage_bucket": "explabs-artifacts",
            "storage_path": f"models/{READY_WM_ID}/{READY_WM_ARTIFACT_ID}.tar.gz",
            "byte_size": 2048,
            "sha256": "a" * 64,
            "created_at": "2026-06-03T01:00:00Z",
        },
    ]
    return client


def _build_app(supabase: FakeSupabaseClient) -> FastAPI:
    """Assemble the current Project app with fake Supabase wiring."""
    return create_app(client=supabase)


@pytest.fixture
def api(
    supabase: FakeSupabaseClient,
) -> TestClient:
    """Authenticated test client with fake Supabase wiring."""
    app = _build_app(supabase)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": ACTOR_ID,
        },
    )


@pytest.fixture
def superadmin_api(
    supabase: FakeSupabaseClient,
) -> TestClient:
    """Test client authenticated with the operator's superadmin key (no actor)."""
    app = _build_app(supabase)
    return TestClient(app, headers={"Authorization": f"Bearer {SUPERADMIN_KEY_SECRET}"})


@pytest.fixture
def customer_api(
    supabase: FakeSupabaseClient,
) -> TestClient:
    """Test client authenticated with org-1's customer API key (no actor)."""
    app = _build_app(supabase)
    return TestClient(app, headers={"Authorization": f"Bearer {CUSTOMER_KEY_SECRET}"})
