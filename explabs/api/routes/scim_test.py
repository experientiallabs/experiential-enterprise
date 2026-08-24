# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the SCIM 2.0 provisioning server."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.routes.scim import router as scim_router
from explabs.db.fake_supabase_test import FakeQuery, FakeResult, FakeSupabaseClient
from explabs.db.repositories import JsonObject, JsonPayload
from explabs.db.stores.api_key_store import hash_api_key

ORG1 = "org-scim-1"
ORG2 = "org-scim-2"
ADMIN1 = "user-scim-admin"
TARGET = "user-scim-target"
LINKABLE = "user-scim-linkable"

ORG1_TOKEN = "xplscim_org1_test_secret"
ORG2_TOKEN = "xplscim_org2_test_secret"

_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"


class _StaticQuery:
    """Query stand-in returning a prepared result."""

    def __init__(self, data: object) -> None:
        self._data = data

    def execute(self) -> FakeResult:
        """Return the prepared payload as the result's data."""
        return FakeResult(cast("list[JsonObject]", self._data))


@dataclass
class _FakeGoTrueUser:
    id: str


@dataclass
class _FakeGoTrueResponse:
    user: _FakeGoTrueUser | None


@dataclass
class _FakeGoTrueAdmin:
    """Records admin create_user calls and mints deterministic ids."""

    owner: ScimFakeClient
    created: list[dict[str, object]] = field(default_factory=list)

    def create_user(self, attributes: dict[str, object]) -> _FakeGoTrueResponse:
        """Create one fake auth user, mirroring GoTrue's insert."""
        self.created.append(dict(attributes))
        user_id = f"user-created-{len(self.created)}"
        self.owner.auth_users[user_id] = str(attributes["email"])
        return _FakeGoTrueResponse(user=_FakeGoTrueUser(id=user_id))


@dataclass
class _FakeAuth:
    admin: _FakeGoTrueAdmin


class ScimFakeClient(FakeSupabaseClient):
    """Fake client with the roster/email RPCs and a GoTrue admin stand-in."""

    def __init__(self) -> None:
        """Seed the GoTrue stand-ins next to the base fake's tables."""
        super().__init__()
        # The auth.users mirror: every known account's email, member or not.
        self.auth_users: dict[str, str] = {}
        self.auth = _FakeAuth(admin=_FakeGoTrueAdmin(owner=self))

    def rpc(self, fn: str, params: JsonPayload | None = None) -> FakeQuery:
        """Serve the SCIM-facing definer RPCs from the seeded state."""
        arguments = dict(params or {})
        match fn:
            case "org_members_with_emails":
                self.executed_rpcs.append(fn)
                rows = [
                    {
                        "user_id": member["user_id"],
                        "email": self.auth_users.get(str(member["user_id"])),
                        "role": member["role"],
                        "created_at": "2026-08-01T00:00:00Z",
                    }
                    for member in self.tables.get("organization_members", [])
                    if member["org_id"] == arguments["target_org_id"]
                ]
                return cast("FakeQuery", _StaticQuery(rows))
            case "admin_user_id_for_email":
                self.executed_rpcs.append(fn)
                wanted = str(arguments["target_email"]).lower()
                found = next(
                    (uid for uid, email in self.auth_users.items() if email.lower() == wanted),
                    None,
                )
                return cast("FakeQuery", _StaticQuery(found))
            case _:
                return super().rpc(fn, params)


@pytest.fixture(autouse=True)
def _scim_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    """License SCIM for the test deployment (default-off otherwise)."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "scim")


@pytest.fixture
def fake() -> ScimFakeClient:
    """Two orgs with live SCIM tokens; the target spans both."""
    client = ScimFakeClient()
    client.tables["organizations"] = [
        {"id": ORG1, "slug": "scim-one", "name": "SCIM One"},
        {"id": ORG2, "slug": "scim-two", "name": "SCIM Two"},
    ]
    client.tables["organization_members"] = [
        {"org_id": ORG1, "user_id": ADMIN1, "role": "admin"},
        {"org_id": ORG1, "user_id": TARGET, "role": "user"},
        {"org_id": ORG2, "user_id": TARGET, "role": "user"},
    ]
    client.auth_users = {
        ADMIN1: "admin@one.example.com",
        TARGET: "target@one.example.com",
        LINKABLE: "linkable@elsewhere.example.com",
    }
    client.tables["org_scim_tokens"] = [
        {
            "org_id": ORG1,
            "token_hash": hash_api_key(ORG1_TOKEN),
            "token_last4": ORG1_TOKEN[-4:],
            "deprovision_key_policy": "revoke",
            "created_by": ADMIN1,
            "created_at": "2026-08-01T00:00:00Z",
            "revoked_at": None,
            "revoked_by": None,
        },
        {
            "org_id": ORG2,
            "token_hash": hash_api_key(ORG2_TOKEN),
            "token_last4": ORG2_TOKEN[-4:],
            "deprovision_key_policy": "keep",
            "created_by": None,
            "created_at": "2026-08-01T00:00:00Z",
            "revoked_at": None,
            "revoked_by": None,
        },
    ]
    client.tables["api_keys"] = [
        {
            "id": "key-target-org1",
            "org_id": ORG1,
            "name": "target org1 key",
            "key_prefix": "xpl_a",
            "key_hash": "a" * 64,
            "created_by": TARGET,
            "created_at": "2026-08-01T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            "revoked_by": None,
            "expires_at": None,
        },
        {
            "id": "key-target-org2",
            "org_id": ORG2,
            "name": "target org2 key",
            "key_prefix": "xpl_b",
            "key_hash": "b" * 64,
            "created_by": TARGET,
            "created_at": "2026-08-01T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            "revoked_by": None,
            "expires_at": None,
        },
    ]
    client.tables["account_provenance"] = []
    return client


def _client(fake: ScimFakeClient, token: str | None = ORG1_TOKEN) -> TestClient:
    """A test client against the SCIM surface, bearer-authenticated."""
    app = create_app(client=fake)
    # create_app deliberately stays untouched by this change; the integrator
    # registers the router with the one line mirrored here.
    app.include_router(scim_router)
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    return TestClient(app, headers=headers)


def _memberships(fake: ScimFakeClient, org_id: str) -> list[str]:
    """The org's member user ids."""
    return [str(m["user_id"]) for m in fake.tables["organization_members"] if m["org_id"] == org_id]


def test_missing_bearer_is_a_scim_401(fake: ScimFakeClient) -> None:
    """No credential answers the RFC 7644 error envelope, not the /api shape."""
    response = _client(fake, token=None).get("/scim/v2/Users")
    assert response.status_code == 401
    body = response.json()
    assert body["schemas"] == [_ERROR_SCHEMA]
    assert body["status"] == "401"
    assert response.headers["content-type"].startswith("application/scim+json")


def test_unknown_bearer_is_the_same_401(fake: ScimFakeClient) -> None:
    """A wrong token is indistinguishable from a missing one."""
    response = _client(fake, "xplscim_wrong").get("/scim/v2/Users")
    assert response.status_code == 401
    assert response.json()["schemas"] == [_ERROR_SCHEMA]


def test_unlicensed_org_answers_404(fake: ScimFakeClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Default-off: a valid bearer without the capability sees nothing."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "")
    response = _client(fake).get("/scim/v2/Users")
    assert response.status_code == 404
    assert response.json()["schemas"] == [_ERROR_SCHEMA]


def test_list_users_returns_the_org_roster(fake: ScimFakeClient) -> None:
    """The org's members project onto SCIM Users with userName = email."""
    response = _client(fake).get("/scim/v2/Users")
    assert response.status_code == 200
    body = response.json()
    assert body["schemas"] == [_LIST_SCHEMA]
    assert body["totalResults"] == 2
    names = {resource["userName"] for resource in body["Resources"]}
    assert names == {"admin@one.example.com", "target@one.example.com"}
    assert all(resource["schemas"] == [_USER_SCHEMA] for resource in body["Resources"])


def test_username_filter_narrows_to_the_matching_user(fake: ScimFakeClient) -> None:
    """The one supported filter shape matches case-insensitively."""
    response = _client(fake).get(
        "/scim/v2/Users", params={"filter": 'userName eq "TARGET@one.example.com"'}
    )
    body = response.json()
    assert body["totalResults"] == 1
    assert body["Resources"][0]["id"] == TARGET


def test_unsupported_filter_is_an_invalid_filter_400(fake: ScimFakeClient) -> None:
    """Anything beyond userName eq is refused, never silently unfiltered."""
    response = _client(fake).get("/scim/v2/Users", params={"filter": 'emails co "one"'})
    assert response.status_code == 400
    assert response.json()["scimType"] == "invalidFilter"


def test_get_user_outside_the_org_is_404(fake: ScimFakeClient) -> None:
    """The org2-only view: an org1 token cannot see org2's exclusive members."""
    fake.tables["organization_members"].append(
        {"org_id": ORG2, "user_id": "user-org2-only", "role": "user"}
    )
    client = _client(fake)
    assert client.get(f"/scim/v2/Users/{TARGET}").status_code == 200
    response = client.get("/scim/v2/Users/user-org2-only")
    assert response.status_code == 404
    assert response.json()["schemas"] == [_ERROR_SCHEMA]


def test_provision_creates_the_account_and_persists_ownership(
    fake: ScimFakeClient,
) -> None:
    """A brand-new userName creates the GoTrue account, provenance, membership."""
    response = _client(fake).post(
        "/scim/v2/Users", json={"schemas": [_USER_SCHEMA], "userName": "New@One.example.com"}
    )
    assert response.status_code == 201
    body = response.json()
    assert body["userName"] == "new@one.example.com"
    user_id = body["id"]

    created = fake.auth.admin.created
    assert len(created) == 1
    assert created[0]["email_confirm"] is True
    metadata = created[0]["user_metadata"]
    assert metadata == {"explabs_provisioned_via": "scim"}

    provenance = fake.tables["account_provenance"]
    assert len(provenance) == 1
    assert provenance[0]["user_id"] == user_id
    assert provenance[0]["provisioned_by_org_id"] == ORG1
    assert provenance[0]["provisioned_via"] == "scim"
    assert user_id in _memberships(fake, ORG1)
    assert "record_audit_event" in fake.executed_rpcs


def test_provision_links_an_existing_account_without_claiming_ownership(
    fake: ScimFakeClient,
) -> None:
    """An existing account is linked: membership yes, provenance never."""
    response = _client(fake).post(
        "/scim/v2/Users", json={"userName": "linkable@elsewhere.example.com"}
    )
    assert response.status_code == 201
    assert fake.auth.admin.created == []
    assert fake.tables["account_provenance"] == []
    assert LINKABLE in _memberships(fake, ORG1)


def test_provision_of_an_existing_member_is_a_uniqueness_409(
    fake: ScimFakeClient,
) -> None:
    """Re-provisioning a member conflicts instead of duplicating membership."""
    response = _client(fake).post("/scim/v2/Users", json={"userName": "target@one.example.com"})
    assert response.status_code == 409
    assert response.json()["scimType"] == "uniqueness"


def test_provision_maps_the_admin_role(fake: ScimFakeClient) -> None:
    """A SCIM roles value of admin lands as the org's admin role."""
    response = _client(fake).post(
        "/scim/v2/Users",
        json={"userName": "boss@one.example.com", "roles": [{"value": "Admin"}]},
    )
    user_id = response.json()["id"]
    membership = next(
        m
        for m in fake.tables["organization_members"]
        if m["org_id"] == ORG1 and m["user_id"] == user_id
    )
    assert membership["role"] == "admin"


def test_patch_active_false_runs_the_sweep_in_this_org_only(
    fake: ScimFakeClient,
) -> None:
    """Deactivation removes the org1 membership + key; org2 stays untouched."""
    response = _client(fake).patch(
        f"/scim/v2/Users/{TARGET}",
        json={
            "schemas": [_PATCH_SCHEMA],
            "Operations": [{"op": "replace", "path": "active", "value": False}],
        },
    )
    assert response.status_code == 200
    assert response.json()["active"] is False

    assert TARGET not in _memberships(fake, ORG1)
    assert TARGET in _memberships(fake, ORG2)
    org1_key = next(row for row in fake.tables["api_keys"] if row["id"] == "key-target-org1")
    org2_key = next(row for row in fake.tables["api_keys"] if row["id"] == "key-target-org2")
    assert org1_key["revoked_at"] is not None
    assert org2_key["revoked_at"] is None
    # Both the core sweep event and the SCIM verb are on the audit stream.
    assert fake.executed_rpcs.count("record_audit_event") == 2


def test_patch_tolerates_the_string_boolean_idps_send(fake: ScimFakeClient) -> None:
    """Azure-style {"active": "False"} inside a pathless replace deprovisions."""
    response = _client(fake).patch(
        f"/scim/v2/Users/{TARGET}",
        json={"Operations": [{"op": "Replace", "value": {"active": "False"}}]},
    )
    assert response.status_code == 200
    assert TARGET not in _memberships(fake, ORG1)


def test_put_active_false_deprovisions(fake: ScimFakeClient) -> None:
    """A full replace carrying active=false is the same deactivation."""
    response = _client(fake).put(
        f"/scim/v2/Users/{TARGET}",
        json={"userName": "target@one.example.com", "active": False},
    )
    assert response.status_code == 200
    assert TARGET not in _memberships(fake, ORG1)


def test_delete_honors_the_orgs_keep_policy(fake: ScimFakeClient) -> None:
    """org2's token (policy=keep) removes membership but leaves keys live."""
    response = _client(fake, token=ORG2_TOKEN).delete(f"/scim/v2/Users/{TARGET}")
    assert response.status_code == 204
    assert TARGET not in _memberships(fake, ORG2)
    assert TARGET in _memberships(fake, ORG1)
    org2_key = next(row for row in fake.tables["api_keys"] if row["id"] == "key-target-org2")
    assert org2_key["revoked_at"] is None


def test_deactivating_the_last_admin_is_a_409_in_the_scim_envelope(
    fake: ScimFakeClient,
) -> None:
    """The core last-admin guard surfaces as a SCIM error, not the /api shape."""
    response = _client(fake).delete(f"/scim/v2/Users/{ADMIN1}")
    assert response.status_code == 409
    assert response.json()["schemas"] == [_ERROR_SCHEMA]
    assert ADMIN1 in _memberships(fake, ORG1)


def test_groups_answer_501_naming_the_teams_mapping(fake: ScimFakeClient) -> None:
    """Groups are honestly unimplemented until teams land."""
    client = _client(fake)
    for response in (
        client.get("/scim/v2/Groups"),
        client.post("/scim/v2/Groups", json={"displayName": "eng"}),
        client.get("/scim/v2/Groups/g-1"),
    ):
        assert response.status_code == 501
        body = response.json()
        assert body["schemas"] == [_ERROR_SCHEMA]
        assert "teams" in body["detail"]


def test_discovery_endpoints_describe_the_real_feature_set(
    fake: ScimFakeClient,
) -> None:
    """ServiceProviderConfig/ResourceTypes/Schemas match what is implemented."""
    client = _client(fake)
    config = client.get("/scim/v2/ServiceProviderConfig").json()
    assert config["patch"]["supported"] is True
    assert config["bulk"]["supported"] is False

    resource_types = client.get("/scim/v2/ResourceTypes").json()
    assert [r["id"] for r in resource_types["Resources"]] == ["User"]

    schemas = client.get("/scim/v2/Schemas").json()
    assert schemas["Resources"][0]["id"] == _USER_SCHEMA
