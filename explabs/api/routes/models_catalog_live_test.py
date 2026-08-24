# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Integration walk for the models management API over a real local schema.

Runs against a disposable local Supabase stack (``SUPABASE_URL`` /
``SUPABASE_SERVICE_ROLE_KEY`` / ``SUPABASE_DB_URL``; skipped when absent) so
the schema's tenancy triggers, nulls-not-distinct conflict semantics, and
``set_updated_at`` triggers are exercised for real, not faked: list → detail →
create custom model → add local deployment → set waterfall override → list
reflects it, plus cross-tenant rejections.

Harness: ``scripts/run_supabase_integration_tests.sh`` (Supabase CLI), or a
compose stack (``docker/compose.yml``) with the same env exported. On shared
Docker hosts use a unique ``EXPLABS_STACK_PROJECT_NAME`` and host ports in the
gitignored ``docker/.env``.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from typing import cast

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import Connection

from explabs.api.app import create_app
from explabs.api.conftest import TEST_API_KEY
from explabs.db.client import get_supabase_client
from explabs.db.repositories import JsonObject

pytestmark = pytest.mark.integration

_ORG_A = "ca7a1060-0000-4000-8000-0000000000a1"
_ORG_B = "ca7a1060-0000-4000-8000-0000000000b1"
_ADMIN_A = "ca7a1060-0000-4000-8000-0000000000a2"
_USER_B = "ca7a1060-0000-4000-8000-0000000000b2"

# The seeded public preferred model the walk chains against (core-P2 seeds).
_PUBLIC_SLUG = "kimi-k2.6"
_CUSTOM_SLUG = "gw-mgmt-live-custom"
_VARIANT_BASE_URL = "http://gw-mgmt-live.internal:8000/v1"


def _database_url() -> str:
    """The disposable integration database, or a skip when not configured."""
    value = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not value:
        pytest.skip("SUPABASE_DB_URL is required for integration tests")
    return value


def _cleanup(connection: Connection[tuple[object, ...]]) -> None:
    """Remove the fixture orgs; catalog rows they own cascade away."""
    connection.execute(
        "delete from public.organizations where id in (%s, %s)",
        (_ORG_A, _ORG_B),
    )


@pytest.fixture
def control() -> Iterator[Connection[tuple[object, ...]]]:
    """Autocommit control connection that seeds and removes the fixture orgs."""
    connection = psycopg.connect(_database_url(), autocommit=True)
    _cleanup(connection)
    connection.execute(
        "insert into public.organizations (id, slug, name) values "
        "(%s, 'gw-mgmt-live-org-a', 'GW Mgmt Live A'), "
        "(%s, 'gw-mgmt-live-org-b', 'GW Mgmt Live B')",
        (_ORG_A, _ORG_B),
    )
    connection.execute(
        "insert into public.organization_members (org_id, user_id, role) values "
        "(%s, %s, 'admin'), (%s, %s, 'user')",
        (_ORG_A, _ADMIN_A, _ORG_B, _USER_B),
    )
    try:
        yield connection
    finally:
        _cleanup(connection)
        connection.close()


def _client(actor_id: str | None) -> TestClient:
    """Deployment-key client over the real service-role Supabase client."""
    headers = {"Authorization": f"Bearer {TEST_API_KEY}"}
    if actor_id is not None:
        headers["X-Explabs-Actor-Id"] = actor_id
    return TestClient(
        create_app(client=get_supabase_client(service_role=True)),
        headers=headers,
    )


def _model_updated_at(connection: Connection[tuple[object, ...]], slug: str) -> object:
    """The public model row's updated_at, straight from Postgres."""
    row = connection.execute(
        "select updated_at from public.models where slug = %s and owning_org_id is null",
        (slug,),
    ).fetchone()
    assert row is not None, f"seeded public model {slug!r} is missing"
    return row[0]


def _entries(body: JsonObject) -> list[JsonObject]:
    """The list response's entries."""
    return cast("list[JsonObject]", body["models"])


def test_reads_and_custom_model_lifecycle(
    control: Connection[tuple[object, ...]],
) -> None:
    """List and detail render anonymously; a custom model stays org-scoped."""
    anonymous = _client(None)
    org_a = _client(_ADMIN_A)
    org_b = _client(_USER_B)

    # 1. Anonymous list: the seeded catalog, public rows only.
    listing = anonymous.get("/api/models")
    assert listing.status_code == 200, listing.text
    slugs = [cast("JsonObject", entry["model"])["slug"] for entry in _entries(listing.json())]
    assert _PUBLIC_SLUG in slugs, "core-P2 seeds must be applied to the stack"
    owners = {
        cast("JsonObject", entry["model"])["owning_org_id"] for entry in _entries(listing.json())
    }
    assert owners == {None}

    # 2. Detail: providers plus the seeded default chain.
    detail = anonymous.get(f"/api/models/{_PUBLIC_SLUG}").json()
    assert cast("list[JsonObject]", detail["default_waterfall"]), (
        "the seeds create a position-0 default rung"
    )

    # 3. Create a custom model in org A; the replay converges, a conflicting
    # body does not (nulls-not-distinct namespace key, exercised for real).
    create_body: JsonObject = {
        "org_id": _ORG_A,
        "slug": _CUSTOM_SLUG,
        "display_name": "GW Mgmt Live Custom",
        "context_window": 8192,
        "providers": [
            {
                "provider": "local",
                "provider_model_id": _CUSTOM_SLUG,
                "base_url": _VARIANT_BASE_URL,
            }
        ],
    }
    created = org_a.post("/api/models", json=create_body)
    assert created.status_code == 201, created.text
    assert org_a.post("/api/models", json=create_body).status_code == 200
    conflicting = {**create_body, "display_name": "Different"}
    conflict = org_a.post("/api/models", json=conflicting)
    assert conflict.status_code == 409
    assert "already exists" in conflict.json()["error"]

    # 4. Visibility: org A sees it (list and detail); anonymous and org B not.
    org_a_slugs = [
        cast("JsonObject", entry["model"])["slug"]
        for entry in _entries(org_a.get("/api/models").json())
    ]
    assert _CUSTOM_SLUG in org_a_slugs
    assert org_a.get(f"/api/models/{_CUSTOM_SLUG}").status_code == 200
    assert anonymous.get(f"/api/models/{_CUSTOM_SLUG}").status_code == 404
    assert org_b.get(f"/api/models/{_CUSTOM_SLUG}").status_code == 404


def test_variant_and_waterfall_override_lifecycle(
    control: Connection[tuple[object, ...]],
) -> None:
    """Add a local variant, set/replay/clear the org override, verify tenancy."""
    anonymous = _client(None)
    org_a = _client(_ADMIN_A)
    org_b = _client(_USER_B)
    detail = anonymous.get(f"/api/models/{_PUBLIC_SLUG}")
    assert detail.status_code == 200, "core-P2 seeds must be applied to the stack"
    default_chain = cast("list[JsonObject]", detail.json()["default_waterfall"])
    assert default_chain, "the seeds create a position-0 default rung"
    public_deployment_id = str(default_chain[0]["model_provider_id"])

    # Add org A's local variant to the public model; identity-key replay.
    variant_body: JsonObject = {
        "org_id": _ORG_A,
        "provider": "local",
        "provider_model_id": _PUBLIC_SLUG,
        "base_url": _VARIANT_BASE_URL,
    }
    variant = org_a.post(f"/api/models/{_PUBLIC_SLUG}/providers", json=variant_body)
    assert variant.status_code == 201, variant.text
    variant_id = str(variant.json()["id"])
    assert org_a.post(f"/api/models/{_PUBLIC_SLUG}/providers", json=variant_body).status_code == 200
    changed = {**variant_body, "input_micro_usd_per_million": 5}
    assert org_a.post(f"/api/models/{_PUBLIC_SLUG}/providers", json=changed).status_code == 409
    # The variant is org A's route only.
    anonymous_provider_ids = {
        str(row["id"])
        for row in anonymous.get(f"/api/models/{_PUBLIC_SLUG}/providers").json()["providers"]
    }
    assert variant_id not in anonymous_provider_ids

    # 6. Waterfall override lifecycle for org A on the public model.
    put_body = {
        "org_id": _ORG_A,
        "model_provider_ids": [variant_id, public_deployment_id],
    }
    put = org_a.put(f"/api/models/{_PUBLIC_SLUG}/waterfall", json=put_body)
    assert put.status_code == 200, put.text
    override = cast("list[JsonObject]", put.json()["override"])
    assert [str(rung["model_provider_id"]) for rung in override] == [
        variant_id,
        public_deployment_id,
    ]
    assert org_a.put(f"/api/models/{_PUBLIC_SLUG}/waterfall", json=put_body).status_code == 200
    read = org_a.get(f"/api/models/{_PUBLIC_SLUG}/waterfall", params={"org_id": _ORG_A}).json()
    assert read["override"] is not None
    # The default chain is untouched by the override.
    read_default = cast("list[JsonObject]", read["default"])
    assert str(next(iter(read_default))["model_provider_id"]) == public_deployment_id

    # 7. Cross-tenant rejection: org B cannot chain org A's private variant,
    # and the 404 does not confirm the foreign row exists.
    foreign = org_b.put(
        f"/api/models/{_PUBLIC_SLUG}/waterfall",
        json={"org_id": _ORG_B, "model_provider_ids": [variant_id]},
    )
    assert foreign.status_code == 404
    assert "not found on model" in foreign.json()["error"]

    # 8. Clearing the override is a pure delete; the model-row touch makes it
    # visible to the catalog builder's poll (real set_updated_at trigger).
    before = _model_updated_at(control, _PUBLIC_SLUG)
    cleared = org_a.put(
        f"/api/models/{_PUBLIC_SLUG}/waterfall",
        json={"org_id": _ORG_A, "model_provider_ids": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["override"] is None
    assert _model_updated_at(control, _PUBLIC_SLUG) != before


def test_write_org_gates_over_the_real_schema(
    control: Connection[tuple[object, ...]],
) -> None:
    """Session actors need a real membership; foreign orgs answer 404."""
    org_b = _client(_USER_B)
    body: JsonObject = {
        "org_id": _ORG_A,
        "slug": f"gw-mgmt-live-{uuid.uuid4().hex[:8]}",
        "display_name": "Foreign Write",
        "providers": [
            {
                "provider": "local",
                "provider_model_id": "foreign",
                "base_url": _VARIANT_BASE_URL,
            }
        ],
    }
    assert org_b.post("/api/models", json=body).status_code == 404
