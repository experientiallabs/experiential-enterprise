# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for the verified-domains half of the SSO substrate."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import ACTOR_ID, ORG_ID, OUTSIDER_ID, TEST_API_KEY, USER_ID
from explabs.api.routes import org_domains as org_domains_module
from explabs.api.routes.org_domains import router as org_domains_router
from explabs.db.fake_supabase_test import FakeQuery, FakeSupabaseClient
from explabs.db.repositories import JsonObject, JsonPayload


class _SsoFakeClient(FakeSupabaseClient):
    """Fake client that records audit emits for the SSO substrate routes."""

    def rpc(self, fn: str, params: JsonPayload | None = None) -> FakeQuery:
        """Capture audit events into the audit_log table; defer the rest."""
        if fn == "record_audit_event":
            self.executed_rpcs.append(fn)
            arguments = dict(params or {})
            self.tables.setdefault("audit_log", []).append(
                {
                    "org_id": arguments.get("p_org_id"),
                    "actor_kind": arguments.get("p_actor_kind"),
                    "actor_id": arguments.get("p_actor_id"),
                    "action": arguments.get("p_action"),
                    "object_type": arguments.get("p_object_type"),
                    "object_id": arguments.get("p_object_id"),
                    "before": arguments.get("p_before"),
                    "after": arguments.get("p_after"),
                }
            )
            return FakeQuery(client=self, table_name="audit_log")
        return super().rpc(fn, params)


@pytest.fixture(autouse=True)
def _sso_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    """License the SSO capability for these tests (default-off otherwise)."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "sso")


@pytest.fixture
def domains_supabase(supabase: FakeSupabaseClient) -> _SsoFakeClient:
    """The conftest seed data transplanted onto the audit-recording fake."""
    client = _SsoFakeClient()
    client.tables = supabase.tables
    client.tables.setdefault("org_domains", [])
    client.tables.setdefault("sso_providers", [])
    return client


def _client(supabase: _SsoFakeClient, actor_id: str) -> TestClient:
    """Deployment-key client acting as one end user.

    Includes the org-domains router when the app factory has not registered
    it yet (registration lives in app.py, which lands separately).
    """
    app = create_app(client=supabase)
    paths = {getattr(route, "path", None) for route in app.routes}
    if "/api/orgs/{org_id}/domains" not in paths:
        app.include_router(org_domains_router)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": actor_id,
        },
    )


def _seeded_domain(
    *,
    domain: str = "example.com",
    challenge: str = "tok-test-aaaaaaaaaaaaaaaaaaaa",
    verified_at: str | None = None,
    sso_required: bool = False,
    org_id: str = ORG_ID,
) -> JsonObject:
    """One org_domains row in the persisted column shape."""
    return {
        "org_id": org_id,
        "domain": domain,
        "verification_token": challenge,
        "verified_at": verified_at,
        "sso_required": sso_required,
        "created_by": ACTOR_ID,
        "created_at": "2026-08-22T00:00:00+00:00",
    }


def _audit_actions(client: _SsoFakeClient) -> list[str]:
    """The audit actions recorded so far, in emit order."""
    return [str(row["action"]) for row in client.tables.get("audit_log", [])]


def test_unlicensed_org_sees_no_surface(
    domains_supabase: _SsoFakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the SSO capability the routes answer a plain 404 (absent)."""
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES")
    response = _client(domains_supabase, ACTOR_ID).get(f"/api/orgs/{ORG_ID}/domains")
    assert response.status_code == 404


def test_member_is_forbidden_and_outsider_sees_nothing(
    domains_supabase: _SsoFakeClient,
) -> None:
    """Members below admin get 403; non-members get the resource 404."""
    member = _client(domains_supabase, USER_ID).get(f"/api/orgs/{ORG_ID}/domains")
    assert member.status_code == 403
    outsider = _client(domains_supabase, OUTSIDER_ID).get(f"/api/orgs/{ORG_ID}/domains")
    assert outsider.status_code == 404


def test_create_returns_the_exact_txt_record(domains_supabase: _SsoFakeClient) -> None:
    """POST claims the domain and tells the operator the record to publish."""
    response = _client(domains_supabase, ACTOR_ID).post(
        f"/api/orgs/{ORG_ID}/domains", json={"domain": " Example.COM. "}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["domain"] == "example.com"
    assert body["txt_record_name"] == "_explabs-verify.example.com"
    assert len(body["txt_record_value"]) >= 20
    assert body["verified_at"] is None
    assert body["sso_required"] is False
    stored = domains_supabase.tables["org_domains"][0]
    assert stored["verification_token"] == body["txt_record_value"]
    assert _audit_actions(domains_supabase) == ["org_domains.create"]


def test_create_refuses_bad_and_duplicate_domains(domains_supabase: _SsoFakeClient) -> None:
    """A malformed domain is a 400; re-claiming the same domain is a 409."""
    client = _client(domains_supabase, ACTOR_ID)
    assert (
        client.post(f"/api/orgs/{ORG_ID}/domains", json={"domain": "not a domain"}).status_code
        == 400
    )
    assert (
        client.post(f"/api/orgs/{ORG_ID}/domains", json={"domain": "https://x.com"}).status_code
        == 400
    )
    assert (
        client.post(f"/api/orgs/{ORG_ID}/domains", json={"domain": "example.com"}).status_code
        == 200
    )
    assert (
        client.post(f"/api/orgs/{ORG_ID}/domains", json={"domain": "example.com"}).status_code
        == 409
    )


def test_verify_matches_the_real_txt_lookup(
    domains_supabase: _SsoFakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A TXT value equal to the token verifies; anything else reports the miss."""
    domains_supabase.tables["org_domains"].append(_seeded_domain())
    looked_up: list[str] = []

    def fake_lookup(name: str) -> list[str]:
        looked_up.append(name)
        return ["unrelated", "tok-test-aaaaaaaaaaaaaaaaaaaa"]

    monkeypatch.setattr(org_domains_module, "_lookup_txt_values", fake_lookup)
    response = _client(domains_supabase, ACTOR_ID).post(
        f"/api/orgs/{ORG_ID}/domains/example.com/verify"
    )
    assert response.status_code == 200, response.text
    assert response.json()["verified_at"] is not None
    assert looked_up == ["_explabs-verify.example.com"]
    assert domains_supabase.tables["org_domains"][0]["verified_at"] is not None
    assert _audit_actions(domains_supabase) == ["org_domains.verify"]


def test_verify_miss_is_a_409_naming_the_record(
    domains_supabase: _SsoFakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No matching TXT value: a 409 with the stable code, nothing stamped."""
    domains_supabase.tables["org_domains"].append(_seeded_domain())
    monkeypatch.setattr(org_domains_module, "_lookup_txt_values", lambda _name: ["wrong"])
    response = _client(domains_supabase, ACTOR_ID).post(
        f"/api/orgs/{ORG_ID}/domains/example.com/verify"
    )
    assert response.status_code == 409
    assert response.json()["code"] == "txt_record_not_found"
    assert domains_supabase.tables["org_domains"][0]["verified_at"] is None
    assert _audit_actions(domains_supabase) == []


def test_verify_refuses_a_domain_verified_elsewhere(
    domains_supabase: _SsoFakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A domain another org already verified cannot be verified again."""
    domains_supabase.tables["org_domains"].append(_seeded_domain())
    domains_supabase.tables["org_domains"].append(
        _seeded_domain(org_id="org-2", verified_at="2026-08-21T00:00:00+00:00")
    )
    monkeypatch.setattr(
        org_domains_module,
        "_lookup_txt_values",
        lambda _name: ["tok-test-aaaaaaaaaaaaaaaaaaaa"],
    )
    response = _client(domains_supabase, ACTOR_ID).post(
        f"/api/orgs/{ORG_ID}/domains/example.com/verify"
    )
    assert response.status_code == 409
    assert "another organization" in response.json()["error"]


def test_sso_required_needs_verification_and_an_enabled_provider(
    domains_supabase: _SsoFakeClient,
) -> None:
    """The toggle refuses unverified domains and provider-less orgs loudly."""
    client = _client(domains_supabase, ACTOR_ID)
    domains_supabase.tables["org_domains"].append(_seeded_domain())
    unverified = client.patch(
        f"/api/orgs/{ORG_ID}/domains/example.com", json={"sso_required": True}
    )
    assert unverified.status_code == 409

    domains_supabase.tables["org_domains"][0]["verified_at"] = "2026-08-22T01:00:00+00:00"
    no_provider = client.patch(
        f"/api/orgs/{ORG_ID}/domains/example.com", json={"sso_required": True}
    )
    assert no_provider.status_code == 409
    assert no_provider.json()["code"] == "sso_provider_required"

    domains_supabase.tables["sso_providers"].append(
        {"org_id": ORG_ID, "provider_type": "saml", "enabled": True}
    )
    enabled = client.patch(f"/api/orgs/{ORG_ID}/domains/example.com", json={"sso_required": True})
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["sso_required"] is True
    assert domains_supabase.tables["org_domains"][0]["sso_required"] is True
    assert _audit_actions(domains_supabase) == ["sso.required_set"]


def test_delete_removes_the_claim(domains_supabase: _SsoFakeClient) -> None:
    """DELETE drops the row and audits what it dropped."""
    domains_supabase.tables["org_domains"].append(_seeded_domain())
    response = _client(domains_supabase, ACTOR_ID).delete(f"/api/orgs/{ORG_ID}/domains/example.com")
    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    assert domains_supabase.tables["org_domains"] == []
    assert _audit_actions(domains_supabase) == ["org_domains.delete"]
    missing = _client(domains_supabase, ACTOR_ID).delete(f"/api/orgs/{ORG_ID}/domains/example.com")
    assert missing.status_code == 404


def test_list_shows_claims_with_state(domains_supabase: _SsoFakeClient) -> None:
    """GET lists every claim with verification state and the TXT record."""
    domains_supabase.tables["org_domains"].append(_seeded_domain())
    domains_supabase.tables["org_domains"].append(
        _seeded_domain(
            domain="corp.example.org",
            challenge="tok-test-bbbbbbbbbbbbbbbbbbbb",
            verified_at="2026-08-22T01:00:00+00:00",
        )
    )
    response = _client(domains_supabase, ACTOR_ID).get(f"/api/orgs/{ORG_ID}/domains")
    assert response.status_code == 200
    body = response.json()
    assert body["org_id"] == ORG_ID
    assert {entry["domain"] for entry in body["domains"]} == {"example.com", "corp.example.org"}
