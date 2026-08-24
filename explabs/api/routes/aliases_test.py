# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Unit tests for the named-alias route helpers and validation.

End-to-end resolution (create -> repoint -> rollback and the catalog-builder
skip) is proven against real Postgres in
``explabs/gateway/named_alias_test.py`` and in the pgTAP suite; these tests
cover the pure request/view/error logic the routes are built from.
"""

from __future__ import annotations

from typing import cast

import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError as PostgrestAPIError
from pydantic import ValidationError

from explabs.api.app import create_app
from explabs.api.conftest import TEST_API_KEY
from explabs.api.routes import ApiError
from explabs.api.routes.aliases import (
    NamedAliasCreate,
    _alias_view,
    _not_routable,
    _translated_rpc_error,
)
from explabs.db.fake_supabase_test import FakeQuery, FakeResult, FakeSupabaseClient
from explabs.db.repositories import JsonObject, JsonPayload


@pytest.mark.parametrize("name", ["coding", "fast-chat", "a", "gpt.5-mini", "team_default"])
def test_named_alias_create_accepts_valid_names(name: str) -> None:
    """Names the gateway can resolve pass validation."""
    body = NamedAliasCreate(name=name, model="gpt-5", org_id="org-1")
    assert body.name == name


@pytest.mark.parametrize(
    "name", ["Coding", "1coding", "coding-", "-coding", "cod ing", "coding__x"]
)
def test_named_alias_create_rejects_unroutable_names(name: str) -> None:
    """Names that could never be a WMO ArtifactId are rejected up front."""
    with pytest.raises(ValidationError):
        NamedAliasCreate(name=name, model="gpt-5", org_id="org-1")


def test_named_alias_create_rejects_bad_model_slug() -> None:
    """The backing model is addressed by a catalog slug, not an arbitrary string."""
    with pytest.raises(ValidationError):
        NamedAliasCreate(name="coding", model="Not A Slug", org_id="org-1")


def test_named_alias_create_forbids_unknown_fields() -> None:
    """Extra fields are a client mistake, not silently dropped."""
    with pytest.raises(ValidationError):
        NamedAliasCreate.model_validate(
            {"name": "coding", "model": "gpt-5", "org_id": "org-1", "surprise": True}
        )


def test_alias_view_projects_current_target() -> None:
    """A resolved alias view carries its current backing model."""
    view = _alias_view(
        {
            "alias_id": "named-1",
            "alias_name": "coding",
            "org_id": "org-1",
            "active": True,
            "current_revision_id": "nrev-1",
        },
        {"model_id": "m-1", "model_slug": "gpt-5"},
    )
    assert view.name == "coding"
    assert view.target_model_slug == "gpt-5"
    assert view.target_model_id == "m-1"
    assert view.current_revision_id == "nrev-1"


def test_alias_view_without_target_is_null_not_empty() -> None:
    """An alias with no recorded target renders explicit nulls."""
    view = _alias_view(
        {
            "alias_id": "named-1",
            "alias_name": "coding",
            "org_id": "org-1",
            "active": False,
            "current_revision_id": None,
        },
        None,
    )
    assert view.active is False
    assert view.current_revision_id is None
    assert view.target_model_slug is None
    assert view.target_model_id is None


@pytest.mark.parametrize(
    ("code", "status"),
    [("23505", 409), ("23514", 422), ("23503", 422), ("P0002", 404)],
)
def test_translated_rpc_error_maps_known_codes(code: str, status: int) -> None:
    """Each gateway rejection code maps to a self-correcting client status."""
    error = PostgrestAPIError({"code": code, "message": "boom"})
    translated = _translated_rpc_error(error, action="creating named alias 'coding'")
    assert isinstance(translated, ApiError)
    assert translated.status_code == status


def test_translated_rpc_error_reraises_unknown() -> None:
    """An unexpected database fault is a real error, not a 4xx."""
    error = PostgrestAPIError({"code": "XX000", "message": "internal"})
    with pytest.raises(PostgrestAPIError):
        _translated_rpc_error(error, action="creating named alias 'coding'")


def test_not_routable_is_conflict() -> None:
    """A model with no catalog deployment yet is a 409, not a 404."""
    error = _not_routable("gpt-5")
    assert error.status_code == 409
    assert "gpt-5" in str(error)


# -- Actor attribution + audit wiring ----------------------------------------

_ORG = "org-alias"
_ADMIN = "user-alias-admin"


class _NoopQuery:
    """RPC stand-in acknowledging a write the way the definer RPC would."""

    def execute(self) -> FakeResult:
        """Return an empty acknowledgement."""
        return FakeResult([])


class _AliasRpcClient(FakeSupabaseClient):
    """Fake that models the two int-p1 alias RPCs the routes call."""

    def __init__(self) -> None:
        super().__init__()
        self.activation_params: list[JsonObject] = []
        self.deactivation_params: list[JsonObject] = []

    def rpc(self, fn: str, params: JsonPayload | None = None) -> FakeQuery:
        """Apply the alias RPC write effects; defer everything else."""
        payload = dict(params or {})
        match fn:
            case "gateway_activate_named_alias_revision":
                self.executed_rpcs.append(fn)
                self.activation_params.append(payload)
                self._activate_named_alias(payload)
            case "gateway_deactivate_alias":
                self.executed_rpcs.append(fn)
                self.deactivation_params.append(payload)
                for row in self.tables.setdefault("gateway_aliases", []):
                    if row.get("alias_id") == payload["p_alias_id"]:
                        row["active"] = False
            case _:
                return super().rpc(fn, params)
        # The stand-in satisfies the only member the routes touch (execute).
        return cast("FakeQuery", _NoopQuery())

    def _activate_named_alias(self, payload: JsonObject) -> None:
        """Upsert the named alias row and record its revision target."""
        aliases = self.tables.setdefault("gateway_aliases", [])
        row = next((r for r in aliases if r.get("alias_id") == payload["p_alias_id"]), None)
        if row is None:
            row = {
                "alias_id": payload["p_alias_id"],
                "alias_name": payload["p_alias_name"],
                "org_id": payload["p_org_id"],
                "origin": "named",
            }
            aliases.append(row)
        row["active"] = True
        row["current_revision_id"] = payload["p_revision_id"]
        self.tables.setdefault("gateway_named_alias_targets", []).append(
            {
                "revision_id": payload["p_revision_id"],
                "model_id": payload["p_model_id"],
                "model_slug": payload["p_model_slug"],
            }
        )


def _alias_api() -> tuple[TestClient, _AliasRpcClient]:
    """One admin-authenticated client over a seeded routable catalog model."""
    supabase = _AliasRpcClient()
    supabase.tables["organizations"] = [{"id": _ORG, "slug": "alias-org", "name": "Alias Org"}]
    supabase.tables["organization_members"] = [{"org_id": _ORG, "user_id": _ADMIN, "role": "admin"}]
    supabase.tables["models"] = [
        {"id": "model-1", "slug": "frontier", "owning_org_id": None, "status": "active"}
    ]
    supabase.tables["gateway_aliases"] = [
        {
            "alias_id": "model-model-1",
            "alias_name": "frontier",
            "org_id": None,
            "origin": "catalog",
            "active": True,
            "current_revision_id": "rev-catalog",
        }
    ]
    supabase.tables["gateway_alias_revisions"] = [
        {
            "revision_id": "rev-catalog",
            "alias_id": "model-model-1",
            "target": {"kind": "direct", "pool_id": "pool-1"},
            "catalog_sha256": "a" * 64,
            "provider_connection_revisions": {},
            "certification": None,
            "refusal_failover": False,
            "created_at": "2026-08-20T00:00:00+00:00",
        }
    ]
    api = TestClient(
        create_app(client=supabase),
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": _ADMIN,
        },
    )
    return api, supabase


def test_alias_writes_carry_the_actor_and_emit_audit_events() -> None:
    """Create and retire pass p_actor to the RPCs and emit one audit event each."""
    api, supabase = _alias_api()

    created = api.post("/api/aliases", json={"org_id": _ORG, "name": "coding", "model": "frontier"})
    assert created.status_code == 201, created.text
    assert created.json()["target_model_slug"] == "frontier"
    assert [params["p_actor"] for params in supabase.activation_params] == [_ADMIN]
    assert supabase.executed_rpcs.count("record_audit_event") == 1

    retired = api.delete("/api/aliases/coding", params={"org_id": _ORG})
    assert retired.status_code == 204, retired.text
    assert [params["p_actor"] for params in supabase.deactivation_params] == [_ADMIN]
    assert supabase.executed_rpcs.count("record_audit_event") == 2
