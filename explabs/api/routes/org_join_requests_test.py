# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for the domain-based join-request API.

Exercised against the fake Supabase client: the domain-match offer, request
creation gating (domain match, email verification, existing membership), the
org-admin approve/deny with its membership grant, and the platform-admin domain
management. Customer-key exclusion from the allowlist is asserted directly.

The fake models neither the ``org_domains`` unique index nor the
``org_join_requests`` pending partial index, so ``_UniqueInsertQuery`` installs
them for the two duplicate-path tests.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import (
    ACTOR_ID,
    OPERATOR_ID,
    ORG_ID,
    OUTSIDER_ID,
    USER_ID,
)
from explabs.db.fake_supabase_test import FakeQuery, FakeSupabaseClient
from explabs.db.repositories import JsonObject
from explabs.db.stores.org_join_store import JoinRequestRecord, OrgJoinStore

DOMAIN = "acme.com"
UNVERIFIED_ID = "user-unverified"


@pytest.fixture(autouse=True)
def _seed_join(supabase: FakeSupabaseClient) -> None:
    """Seed a domain association and the users the requester tests act as.

    Inbox proof is now the decoupled signal (founding org spend-unlocked), NOT
    email_confirmed_at -- every signup is auto-confirmed for login. So each
    requester also gets a founding org whose spend_unlocked_at expresses whether
    they have PROVEN their inbox: the outsider has, the "unverified" signup has
    not (auto-confirmed but never proved the inbox -- the exact instant-signup
    attacker shape the domain-join gate must still reject).
    """
    supabase.tables["org_domains"] = [
        {
            "id": "domain-1",
            "org_id": ORG_ID,
            "domain": DOMAIN,
            "created_at": "2026-08-01T00:00:00Z",
            # Operator-asserted rows are verified at birth (E2 convergence,
            # 20260901140000): only verified domains drive join offers.
            "verified_at": "2026-08-01T00:00:00Z",
        }
    ]
    supabase.tables["org_join_requests"] = []
    supabase.tables["auth_users"] = [
        # An outsider whose email domain matches org-1 and who proved their inbox.
        {"id": OUTSIDER_ID, "email": "dev@acme.com", "email_confirmed_at": "2026-08-02T00:00:00Z"},
        # A matching-domain signup: auto-confirmed for login but inbox NOT proven.
        {
            "id": UNVERIFIED_ID,
            "email": "new@acme.com",
            "email_confirmed_at": "2026-08-02T00:00:00Z",
        },
        # An existing org-1 member on the same domain.
        {"id": USER_ID, "email": "member@acme.com", "email_confirmed_at": "2026-08-01T00:00:00Z"},
        # An admin whose email domain does not match any org.
        {
            "id": ACTOR_ID,
            "email": "admin@elsewhere.io",
            "email_confirmed_at": "2026-08-01T00:00:00Z",
        },
    ]
    # Founding orgs expressing inbox-proof state: unlocked = proven, null = not.
    supabase.tables["organizations"].extend(
        [
            {
                "id": "org-outsider",
                "slug": "org-outsider",
                "name": "Outsider",
                "spend_unlocked_at": "2026-08-02T00:00:00Z",
            },
            {
                "id": "org-unverified",
                "slug": "org-unverified",
                "name": "Unverified",
                "spend_unlocked_at": None,
            },
            # The existing org-1 member founded their own (unlocked) org, so they
            # are inbox-proven and the create gate reaches the already-member check.
            {
                "id": "org-user",
                "slug": "org-user",
                "name": "User",
                "spend_unlocked_at": "2026-08-02T00:00:00Z",
            },
        ]
    )
    supabase.tables["organization_members"].extend(
        [
            {"org_id": "org-outsider", "user_id": OUTSIDER_ID, "role": "admin"},
            {"org_id": "org-unverified", "user_id": UNVERIFIED_ID, "role": "admin"},
            {"org_id": "org-user", "user_id": USER_ID, "role": "admin"},
        ]
    )


# -- Duplicate-index shim -----------------------------------------------------


class _UniqueInsertQuery(FakeQuery):
    """Enforce the domain and pending-request unique constraints."""

    def _insert(self) -> list[JsonObject]:
        rows = self.client.tables.setdefault(self.table_name, [])
        if self.table_name == "org_domains":
            existing = {row.get("domain") for row in rows}
            if any(payload.get("domain") in existing for payload in self.payloads):
                raise RuntimeError({"code": "23505", "message": "duplicate domain"})
        if self.table_name == "org_join_requests":
            pending = {
                (row.get("org_id"), row.get("user_id"))
                for row in rows
                if row.get("status") == "pending"
            }
            for payload in self.payloads:
                if (payload.get("org_id"), payload.get("user_id")) in pending:
                    raise RuntimeError({"code": "23505", "message": "duplicate pending request"})
        return super()._insert()


@pytest.fixture
def _enforce_unique_inserts(monkeypatch: pytest.MonkeyPatch) -> None:
    original = FakeSupabaseClient.table

    def table(self: FakeSupabaseClient, table_name: str) -> FakeQuery:
        query = original(self, table_name)
        if table_name in ("org_domains", "org_join_requests"):
            query.__class__ = _UniqueInsertQuery
        return query

    monkeypatch.setattr(FakeSupabaseClient, "table", table)


def _as(api: TestClient, actor: str) -> TestClient:
    """Point the shared client at a different acting user."""
    api.headers["X-Explabs-Actor-Id"] = actor
    return api


# -- Requester: offer ---------------------------------------------------------


def test_offer_for_matching_verified_outsider(api: TestClient) -> None:
    """A verified non-member on a matched domain is offered the join."""
    offer = _as(api, OUTSIDER_ID).get("/api/join-requests/offer").json()["offer"]
    assert offer is not None
    assert offer["org_id"] == ORG_ID
    assert offer["org_name"] == "Experiential Labs"
    assert offer["org_slug"] == "experiential-labs"
    assert offer["email_verified"] is True
    assert offer["already_member"] is False
    assert offer["request_status"] is None


def test_offer_null_when_domain_unmatched(api: TestClient) -> None:
    """No offer when the email domain maps to no org."""
    assert _as(api, ACTOR_ID).get("/api/join-requests/offer").json() == {"offer": None}


def test_offer_reports_existing_membership(api: TestClient) -> None:
    """A member on the matched domain is offered nothing to request."""
    offer = _as(api, USER_ID).get("/api/join-requests/offer").json()["offer"]
    assert offer is not None
    assert offer["already_member"] is True


def test_offer_reflects_pending_request(api: TestClient) -> None:
    """Once a request is open, the offer reports its status."""
    _as(api, OUTSIDER_ID).post("/api/join-requests")
    offer = _as(api, OUTSIDER_ID).get("/api/join-requests/offer").json()["offer"]
    assert offer["request_status"] == "pending"


# -- Requester: create --------------------------------------------------------


def test_create_request_for_verified_outsider(api: TestClient) -> None:
    """A matched, verified non-member opens a pending request."""
    response = _as(api, OUTSIDER_ID).post("/api/join-requests")
    assert response.status_code == 201
    body = response.json()
    assert body["org_id"] == ORG_ID
    assert body["org_name"] == "Experiential Labs"
    assert body["status"] == "pending"


def test_create_request_rejects_unmatched_domain(api: TestClient) -> None:
    """A domain that maps to no org is a 404."""
    assert _as(api, ACTOR_ID).post("/api/join-requests").status_code == 404


def test_create_request_rejects_auto_confirmed_but_inbox_unproven(api: TestClient) -> None:
    """An auto-confirmed signup that has NOT proved its inbox cannot request access.

    Security regression guard: instant signup sets email_confirmed_at eagerly, so
    the gate must key on the decoupled inbox-proof signal (founding org still
    spend-locked here) -- otherwise an attacker who instant-signs-up
    victim@acme.com could open a domain-join request against acme's org.
    """
    response = _as(api, UNVERIFIED_ID).post("/api/join-requests")
    assert response.status_code == 403
    assert response.json()["code"] == "email_unverified"


def test_create_request_rejects_existing_member(api: TestClient) -> None:
    """A current member gets a 409, not a duplicate request."""
    assert _as(api, USER_ID).post("/api/join-requests").status_code == 409


@pytest.mark.usefixtures("_enforce_unique_inserts")
def test_create_request_rejects_second_pending(api: TestClient) -> None:
    """A second pending request for the same org is a 409."""
    assert _as(api, OUTSIDER_ID).post("/api/join-requests").status_code == 201
    assert _as(api, OUTSIDER_ID).post("/api/join-requests").status_code == 409


def test_customer_key_cannot_reach_requester_routes(customer_api: TestClient) -> None:
    """An xpl_ key is outside the allowlist for the join-request surface."""
    assert customer_api.get("/api/join-requests/offer").status_code == 401
    assert customer_api.post("/api/join-requests").status_code == 401


# -- Org admin: list / approve / deny ----------------------------------------


def _open_request(api: TestClient) -> str:
    """Open one request as the outsider and return its id."""
    return _as(api, OUTSIDER_ID).post("/api/join-requests").json()["id"]


def test_admin_lists_pending_requests(api: TestClient) -> None:
    """An org admin sees pending requests with the requester's email."""
    _open_request(api)
    requests = _as(api, ACTOR_ID).get(f"/api/orgs/{ORG_ID}/join-requests").json()["requests"]
    assert len(requests) == 1
    assert requests[0]["user_id"] == OUTSIDER_ID
    assert requests[0]["email"] == "dev@acme.com"


def test_member_cannot_list_requests(api: TestClient) -> None:
    """A plain member may not read the pending-request roster."""
    assert _as(api, USER_ID).get(f"/api/orgs/{ORG_ID}/join-requests").status_code == 403


def test_non_member_gets_not_found_listing(api: TestClient) -> None:
    """A non-member gets the org's 404, not a 403 that confirms it exists."""
    assert _as(api, OUTSIDER_ID).get(f"/api/orgs/{ORG_ID}/join-requests").status_code == 404


def test_admin_approve_grants_membership(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Approval grants the requester membership at user role and settles it."""
    request_id = _open_request(api)
    response = _as(api, ACTOR_ID).post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/approve")
    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    members = supabase.tables["organization_members"]
    assert any(
        member["org_id"] == ORG_ID and member["user_id"] == OUTSIDER_ID and member["role"] == "user"
        for member in members
    )
    # The request no longer appears as pending.
    remaining = _as(api, ACTOR_ID).get(f"/api/orgs/{ORG_ID}/join-requests").json()["requests"]
    assert remaining == []


def test_member_cannot_approve(api: TestClient) -> None:
    """A plain member may not approve a request."""
    request_id = _open_request(api)
    assert (
        _as(api, USER_ID).post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/approve").status_code
        == 403
    )


def test_deny_settles_without_membership(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Denial settles the request and grants no membership."""
    request_id = _open_request(api)
    response = _as(api, ACTOR_ID).post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/deny")
    assert response.status_code == 200
    assert response.json()["status"] == "denied"
    assert not any(
        member["org_id"] == ORG_ID and member["user_id"] == OUTSIDER_ID
        for member in supabase.tables["organization_members"]
    )


def _ban_org(supabase: FakeSupabaseClient, org_id: str) -> None:
    """Mark one org banned the way record_org_ban does (banned_at set)."""
    for row in supabase.tables["organizations"]:
        if row["id"] == org_id:
            row["banned_at"] = "2026-08-29T00:00:00Z"


def test_offer_null_when_org_banned(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A banned org is never offered, the same silence as no domain match."""
    _ban_org(supabase, ORG_ID)
    assert _as(api, OUTSIDER_ID).get("/api/join-requests/offer").json() == {"offer": None}


def test_create_request_rejects_banned_org(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Opening a request against a banned org 404s neutrally (no ban oracle)."""
    _ban_org(supabase, ORG_ID)
    assert _as(api, OUTSIDER_ID).post("/api/join-requests").status_code == 404


def test_approve_refused_while_org_banned_deny_still_works(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A banned org may not grow: approve 409s, the request stays pending.

    Deny keeps working while the org is banned.
    """
    request_id = _open_request(api)
    _ban_org(supabase, ORG_ID)
    approve = _as(api, ACTOR_ID).post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/approve")
    assert approve.status_code == 409
    assert "banned" in approve.json()["error"]
    assert not any(
        member["org_id"] == ORG_ID and member["user_id"] == OUTSIDER_ID
        for member in supabase.tables["organization_members"]
    )
    # Still pending, so an unban makes it decidable again; deny works now too.
    deny = _as(api, ACTOR_ID).post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/deny")
    assert deny.status_code == 200
    assert deny.json()["status"] == "denied"


def test_decide_already_settled_is_conflict(api: TestClient) -> None:
    """Approving an already-denied request is a 409."""
    request_id = _open_request(api)
    _as(api, ACTOR_ID).post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/deny")
    assert (
        _as(api, ACTOR_ID)
        .post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/approve")
        .status_code
        == 409
    )


def test_approve_conflicts_when_denied_concurrently(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A concurrent deny that won the race makes approve a 409, not a 200."""
    request_id = _open_request(api)
    denied = JoinRequestRecord(
        id=request_id,
        org_id=ORG_ID,
        user_id=OUTSIDER_ID,
        email="dev@acme.com",
        status="denied",
        created_at="2026-08-21T00:00:00Z",
        decided_at="2026-08-21T00:00:01Z",
        decided_by="other-admin",
    )
    monkeypatch.setattr(OrgJoinStore, "approve_request", lambda *_args, **_kwargs: denied)
    response = _as(api, ACTOR_ID).post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/approve")
    assert response.status_code == 409


def test_deny_conflicts_when_approved_concurrently(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A concurrent approve that won the race makes deny a 409, not a 200."""
    request_id = _open_request(api)
    approved = JoinRequestRecord(
        id=request_id,
        org_id=ORG_ID,
        user_id=OUTSIDER_ID,
        email="dev@acme.com",
        status="approved",
        created_at="2026-08-21T00:00:00Z",
        decided_at="2026-08-21T00:00:01Z",
        decided_by="other-admin",
    )
    monkeypatch.setattr(OrgJoinStore, "deny_request", lambda *_args, **_kwargs: approved)
    response = _as(api, ACTOR_ID).post(f"/api/orgs/{ORG_ID}/join-requests/{request_id}/deny")
    assert response.status_code == 409


def test_unknown_request_is_not_found(api: TestClient) -> None:
    """A missing request id is a 404 for an admin."""
    assert (
        _as(api, ACTOR_ID).post(f"/api/orgs/{ORG_ID}/join-requests/ghost/approve").status_code
        == 404
    )


# -- Platform admin: domain management ---------------------------------------


def test_platform_admin_domain_crud(api: TestClient) -> None:
    """A platform admin lists, adds, and removes domain associations."""
    listed = _as(api, OPERATOR_ID).get(f"/api/admin/orgs/{ORG_ID}/domains").json()["domains"]
    assert [row["domain"] for row in listed] == [DOMAIN]

    created = _as(api, OPERATOR_ID).post(
        f"/api/admin/orgs/{ORG_ID}/domains", json={"domain": "Example.COM"}
    )
    assert created.status_code == 201
    assert created.json()["domain"] == "example.com"

    domain_id = created.json()["id"]
    deleted = _as(api, OPERATOR_ID).delete(f"/api/admin/orgs/{ORG_ID}/domains/{domain_id}")
    assert deleted.status_code == 200
    assert (
        _as(api, OPERATOR_ID).delete(f"/api/admin/orgs/{ORG_ID}/domains/{domain_id}").status_code
        == 404
    )


def test_org_admin_cannot_manage_domains(api: TestClient) -> None:
    """Domain association is platform-operator only; an org admin gets 404."""
    assert _as(api, ACTOR_ID).get(f"/api/admin/orgs/{ORG_ID}/domains").status_code == 404
    assert (
        _as(api, ACTOR_ID)
        .post(f"/api/admin/orgs/{ORG_ID}/domains", json={"domain": "x.com"})
        .status_code
        == 404
    )


@pytest.mark.parametrize("bad", ["nodot", "has@at.com", "trailing.", ".leading", "with space.com"])
def test_domain_validation(api: TestClient, bad: str) -> None:
    """A non-bare-domain value is a 422."""
    assert (
        _as(api, OPERATOR_ID)
        .post(f"/api/admin/orgs/{ORG_ID}/domains", json={"domain": bad})
        .status_code
        == 422
    )


@pytest.mark.usefixtures("_enforce_unique_inserts")
def test_duplicate_domain_is_conflict(api: TestClient) -> None:
    """Re-adding an existing domain is a 409."""
    assert (
        _as(api, OPERATOR_ID)
        .post(f"/api/admin/orgs/{ORG_ID}/domains", json={"domain": DOMAIN})
        .status_code
        == 409
    )
