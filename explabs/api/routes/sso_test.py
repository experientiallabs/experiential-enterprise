# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for the per-org SSO provider registration surface."""

from __future__ import annotations

from typing import cast

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import ACTOR_ID, ORG_ID, OUTSIDER_ID, TEST_API_KEY, USER_ID
from explabs.api.routes.sso import router as sso_router
from explabs.db.fake_supabase_test import FakeQuery, FakeResult, FakeSupabaseClient
from explabs.db.repositories import JsonObject, JsonPayload


class _RowsQuery:
    """RPC stand-in returning prepared rows."""

    def __init__(self, rows: list[JsonObject]) -> None:
        self._rows = rows

    def execute(self) -> FakeResult:
        """Return the prepared rows."""
        return FakeResult([dict(row) for row in self._rows])


class _SsoProviderClient(FakeSupabaseClient):
    """Fake client modeling the sso_providers definer RPCs and audit emits."""

    def rpc(self, fn: str, params: JsonPayload | None = None) -> FakeQuery:
        """Model the SSO provider write path; defer everything else."""
        arguments = dict(params or {})
        match fn:
            case "record_audit_event":
                self.executed_rpcs.append(fn)
                self.tables.setdefault("audit_log", []).append(
                    {
                        "org_id": arguments.get("p_org_id"),
                        "action": arguments.get("p_action"),
                        "object_type": arguments.get("p_object_type"),
                        "object_id": arguments.get("p_object_id"),
                        "before": arguments.get("p_before"),
                        "after": arguments.get("p_after"),
                    }
                )
                return cast("FakeQuery", _RowsQuery([]))
            case "upsert_sso_provider":
                self.executed_rpcs.append(fn)
                return cast("FakeQuery", _RowsQuery([self._upsert_provider(arguments)]))
            case "delete_sso_provider":
                self.executed_rpcs.append(fn)
                return cast("FakeQuery", _RowsQuery([self._delete_provider(arguments)]))
            case _:
                return super().rpc(fn, params)

    def _upsert_provider(self, arguments: JsonObject) -> JsonObject:
        """Insert-or-update the single per-org row, secret into the fake Vault."""
        org_id = arguments.get("in_org_id")
        rows = self.tables.setdefault("sso_providers", [])
        row = next((r for r in rows if r.get("org_id") == org_id), None)
        if row is None:
            row = {"id": f"sso-{len(rows) + 1}", "org_id": org_id}
            rows.append(row)
        secret = arguments.get("in_secret")
        if isinstance(secret, str) and secret:
            self.vault_secrets[f"sso:{org_id}"] = secret
            row["vault_secret_id"] = f"vault-{org_id}"
        elif arguments.get("in_provider_type") == "saml":
            self.vault_secrets.pop(f"sso:{org_id}", None)
            row["vault_secret_id"] = None
        row.update(
            {
                "provider_type": arguments.get("in_provider_type"),
                "metadata": arguments.get("in_metadata") or {},
                "default_role": arguments.get("in_default_role"),
                "enabled": arguments.get("in_enabled"),
            }
        )
        return {**row, "has_client_secret": row.get("vault_secret_id") is not None}

    def _delete_provider(self, arguments: JsonObject) -> JsonObject:
        """Drop the row and its fake Vault secret."""
        org_id = arguments.get("in_org_id")
        rows = self.tables.setdefault("sso_providers", [])
        row = next((r for r in rows if r.get("org_id") == org_id), None)
        if row is None:
            return {"delete_sso_provider": False}
        rows.remove(row)
        self.vault_secrets.pop(f"sso:{org_id}", None)
        return {"delete_sso_provider": True}


@pytest.fixture(autouse=True)
def _sso_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    """License the SSO capability for these tests (default-off otherwise)."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "sso")


@pytest.fixture
def sso_supabase(supabase: FakeSupabaseClient) -> _SsoProviderClient:
    """The conftest seed data transplanted onto the provider-aware fake."""
    client = _SsoProviderClient()
    client.tables = supabase.tables
    client.tables.setdefault("org_domains", [])
    client.tables.setdefault("sso_providers", [])
    return client


def _client(supabase: _SsoProviderClient, actor_id: str) -> TestClient:
    """Deployment-key client acting as one end user (router self-included)."""
    app = create_app(client=supabase)
    paths = {getattr(route, "path", None) for route in app.routes}
    if "/api/orgs/{org_id}/sso-provider" not in paths:
        app.include_router(sso_router)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": actor_id,
        },
    )


def _verified_domain(*, sso_required: bool = False) -> JsonObject:
    """One verified org_domains row for ORG_ID."""
    return {
        "org_id": ORG_ID,
        "domain": "example.com",
        "verification_token": "tok-test-aaaaaaaaaaaaaaaaaaaa",
        "verified_at": "2026-08-22T00:00:00+00:00",
        "sso_required": sso_required,
    }


_OIDC_BODY: JsonObject = {
    "provider_type": "oidc",
    "metadata": {"issuer": "https://accounts.example.com", "client_id": "abc"},
    "default_role": "user",
    "enabled": False,
    "client_secret": "oidc-client-secret-value",
}


def test_unlicensed_org_sees_no_surface(
    sso_supabase: _SsoProviderClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the SSO capability the surface answers a plain 404 (absent)."""
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES")
    response = _client(sso_supabase, ACTOR_ID).get(f"/api/orgs/{ORG_ID}/sso-provider")
    assert response.status_code == 404


def test_member_is_forbidden_and_outsider_sees_nothing(
    sso_supabase: _SsoProviderClient,
) -> None:
    """Members below admin get 403; non-members get the resource 404."""
    member = _client(sso_supabase, USER_ID).get(f"/api/orgs/{ORG_ID}/sso-provider")
    assert member.status_code == 403
    outsider = _client(sso_supabase, OUTSIDER_ID).get(f"/api/orgs/{ORG_ID}/sso-provider")
    assert outsider.status_code == 404


def test_oidc_secret_rides_vault_and_is_never_echoed(
    sso_supabase: _SsoProviderClient,
) -> None:
    """The PUT stores the secret through the RPC and answers has_client_secret."""
    response = _client(sso_supabase, ACTOR_ID).put(
        f"/api/orgs/{ORG_ID}/sso-provider", json=dict(_OIDC_BODY)
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["has_client_secret"] is True
    assert "client_secret" not in body
    assert sso_supabase.vault_secrets[f"sso:{ORG_ID}"] == "oidc-client-secret-value"
    audit = sso_supabase.tables["audit_log"][0]
    assert audit["action"] == "sso.provider_set"
    # The emit seam's redaction is the backstop, but the handler never even
    # offers the secret to the audit payload.
    assert "client_secret" not in str(audit["after"])


def test_metadata_is_typed_per_provider(sso_supabase: _SsoProviderClient) -> None:
    """Wrong-shape metadata and a SAML secret both fail as typed 400s."""
    client = _client(sso_supabase, ACTOR_ID)
    missing_issuer = client.put(
        f"/api/orgs/{ORG_ID}/sso-provider",
        json={"provider_type": "oidc", "metadata": {"client_id": "abc"}},
    )
    assert missing_issuer.status_code == 400
    plain_http = client.put(
        f"/api/orgs/{ORG_ID}/sso-provider",
        json={
            "provider_type": "saml",
            "metadata": {"metadata_url": "http://idp.example.com/metadata"},
        },
    )
    assert plain_http.status_code == 400
    saml_secret = client.put(
        f"/api/orgs/{ORG_ID}/sso-provider",
        json={
            "provider_type": "saml",
            "metadata": {"metadata_url": "https://idp.example.com/metadata"},
            "client_secret": "not-a-saml-thing",
        },
    )
    assert saml_secret.status_code == 400


def test_enabling_requires_a_verified_domain(sso_supabase: _SsoProviderClient) -> None:
    """enabled=true is refused until the org has one verified domain."""
    client = _client(sso_supabase, ACTOR_ID)
    body = {**_OIDC_BODY, "enabled": True}
    refused = client.put(f"/api/orgs/{ORG_ID}/sso-provider", json=body)
    assert refused.status_code == 409
    assert refused.json()["code"] == "verified_domain_required"

    sso_supabase.tables["org_domains"].append(_verified_domain())
    allowed = client.put(f"/api/orgs/{ORG_ID}/sso-provider", json=body)
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["enabled"] is True


def test_no_lockout_while_a_domain_requires_sso(
    sso_supabase: _SsoProviderClient,
) -> None:
    """Disabling or deleting the provider is refused while sso_required is on."""
    client = _client(sso_supabase, ACTOR_ID)
    sso_supabase.tables["org_domains"].append(_verified_domain(sso_required=True))
    sso_supabase.tables["sso_providers"].append(
        {
            "org_id": ORG_ID,
            "provider_type": "oidc",
            "metadata": {"issuer": "https://accounts.example.com", "client_id": "abc"},
            "default_role": "user",
            "enabled": True,
            "vault_secret_id": None,
        }
    )
    disable = client.put(f"/api/orgs/{ORG_ID}/sso-provider", json={**_OIDC_BODY, "enabled": False})
    assert disable.status_code == 409
    assert disable.json()["code"] == "sso_required_active"
    delete = client.delete(f"/api/orgs/{ORG_ID}/sso-provider")
    assert delete.status_code == 409
    assert delete.json()["code"] == "sso_required_active"


def test_get_and_delete_round_trip(sso_supabase: _SsoProviderClient) -> None:
    """GET 404s when absent; after a PUT it reads back; DELETE removes it."""
    client = _client(sso_supabase, ACTOR_ID)
    assert client.get(f"/api/orgs/{ORG_ID}/sso-provider").status_code == 404

    put = client.put(f"/api/orgs/{ORG_ID}/sso-provider", json=dict(_OIDC_BODY))
    assert put.status_code == 200, put.text

    read = client.get(f"/api/orgs/{ORG_ID}/sso-provider")
    assert read.status_code == 200
    assert read.json()["provider_type"] == "oidc"
    assert read.json()["has_client_secret"] is True

    deleted = client.delete(f"/api/orgs/{ORG_ID}/sso-provider")
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert sso_supabase.tables["sso_providers"] == []
    assert f"sso:{ORG_ID}" not in sso_supabase.vault_secrets
    actions = [str(row["action"]) for row in sso_supabase.tables["audit_log"]]
    assert actions == ["sso.provider_set", "sso.provider_delete"]
    assert client.delete(f"/api/orgs/{ORG_ID}/sso-provider").status_code == 404
