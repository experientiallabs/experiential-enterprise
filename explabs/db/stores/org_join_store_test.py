# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Store-level tests for domain-based join requests.

These drive the store directly against the fake Supabase client: the domain
parser, the domain/request CRUD, the definer verification RPC shim, and the
approve/deny transitions including the membership grant and idempotency guard.

The vanilla fake models neither the ``org_domains`` global unique index nor the
``org_join_requests`` pending partial index, so ``_UniqueInsertQuery`` installs
those two constraints for the duplicate-path tests, raising the PostgREST 23505
shape the store translates.
"""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeQuery, FakeSupabaseClient
from explabs.db.repositories import JsonObject
from explabs.db.stores.org_join_store import (
    DuplicateOrgDomainError,
    DuplicatePendingRequestError,
    OrgJoinStore,
    email_domain,
)

ORG_ID = "org-1"
USER_ID = "user-9"


@pytest.mark.parametrize(
    ("email", "expected"),
    [
        ("a@experientiallabs.ai", "experientiallabs.ai"),
        ("Mixed.Case@Experiential.AI", "experiential.ai"),
        ("  padded@example.com  ", "example.com"),
        ("no-at-sign", None),
        ("@example.com", None),
        ("a@b@example.com", None),
        ("a@localhost", None),
        ("a@.com", None),
        ("a@example.", None),
    ],
)
def test_email_domain(email: str, expected: str | None) -> None:
    """The parser lowercases valid domains and rejects malformed addresses."""
    assert email_domain(email) == expected


def _store() -> tuple[FakeSupabaseClient, OrgJoinStore]:
    client = FakeSupabaseClient()
    client.tables["organizations"] = [{"id": ORG_ID, "slug": "acme", "name": "Acme"}]
    client.tables["organization_members"] = []
    client.tables["org_domains"] = []
    client.tables["org_join_requests"] = []
    client.tables["auth_users"] = []
    return client, OrgJoinStore(client)


class _UniqueInsertQuery(FakeQuery):
    """A query enforcing the two unique constraints the vanilla fake skips."""

    def _insert(self) -> list[JsonObject]:
        """Raise the PostgREST 23505 shape on a colliding domain / pending row."""
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
    """Make org_domains / org_join_requests inserts constraint-enforcing."""
    original = FakeSupabaseClient.table

    def table(self: FakeSupabaseClient, table_name: str) -> FakeQuery:
        query = original(self, table_name)
        if table_name in ("org_domains", "org_join_requests"):
            query.__class__ = _UniqueInsertQuery
        return query

    monkeypatch.setattr(FakeSupabaseClient, "table", table)


def test_add_domain_lowercases_and_is_findable_any_case() -> None:
    """A domain is stored lowercased and found regardless of query case."""
    _client, store = _store()
    record = store.add_org_domain(org_id=ORG_ID, domain="Acme.COM", created_by=None)
    assert record.domain == "acme.com"
    assert store.find_domain("ACME.com") is not None
    assert store.find_domain("unknown.com") is None


@pytest.mark.usefixtures("_enforce_unique_inserts")
def test_add_domain_is_unique_globally() -> None:
    """A domain already associated with any org is rejected."""
    _client, store = _store()
    store.add_org_domain(org_id=ORG_ID, domain="acme.com", created_by=None)
    with pytest.raises(DuplicateOrgDomainError):
        store.add_org_domain(org_id="org-2", domain="acme.com", created_by=None)


def test_user_verification_reads_rpc() -> None:
    """The store reads email + inbox-proof state through the definer RPC shim.

    inbox_proven mirrors the spend-gate signal: the user is the founding admin of
    a spend-UNLOCKED org, NOT the raw email_confirmed_at login flag (both users
    here are auto-confirmed, as instant signup now leaves everyone).
    """
    client, store = _store()
    client.tables["auth_users"] = [
        {"id": USER_ID, "email": "dev@acme.com", "email_confirmed_at": "2026-08-01T00:00:00Z"},
        {"id": "user-x", "email": "x@acme.com", "email_confirmed_at": "2026-08-01T00:00:00Z"},
    ]
    client.tables["organizations"] = [
        {"id": "org-proven", "spend_unlocked_at": "2026-08-02T00:00:00Z"},
        {"id": "org-locked", "spend_unlocked_at": None},
    ]
    client.tables["organization_members"] = [
        {"org_id": "org-proven", "user_id": USER_ID, "role": "admin"},
        {"org_id": "org-locked", "user_id": "user-x", "role": "admin"},
    ]
    verified = store.user_verification(USER_ID)
    assert verified is not None
    assert verified.email == "dev@acme.com"
    # Founding admin of a spend-unlocked org -> inbox proven.
    assert verified.inbox_proven is True

    # Auto-confirmed but their founding org is still spend-locked -> NOT proven.
    unverified = store.user_verification("user-x")
    assert unverified is not None
    assert unverified.inbox_proven is False

    assert store.user_verification("ghost") is None


@pytest.mark.usefixtures("_enforce_unique_inserts")
def test_create_request_rejects_second_pending() -> None:
    """A second pending request for the same (org, user) is refused."""
    _client, store = _store()
    store.create_request(org_id=ORG_ID, user_id=USER_ID, email="dev@acme.com")
    with pytest.raises(DuplicatePendingRequestError):
        store.create_request(org_id=ORG_ID, user_id=USER_ID, email="dev@acme.com")


def test_approve_grants_membership_and_marks_approved() -> None:
    """Approval inserts a member row at user role and settles the request."""
    client, store = _store()
    request = store.create_request(org_id=ORG_ID, user_id=USER_ID, email="dev@acme.com")
    decided = store.approve_request(request, decided_by="admin-1")

    assert decided.status == "approved"
    assert decided.decided_by == "admin-1"
    assert decided.decided_at is not None
    members = client.tables["organization_members"]
    assert len(members) == 1
    assert members[0]["org_id"] == ORG_ID
    assert members[0]["user_id"] == USER_ID
    assert members[0]["role"] == "user"


def test_approve_preserves_an_existing_membership() -> None:
    """Re-granting an existing member neither doubles nor downgrades the row."""
    client, store = _store()
    client.tables["organization_members"] = [
        {"org_id": ORG_ID, "user_id": USER_ID, "role": "admin"}
    ]
    request = store.create_request(org_id=ORG_ID, user_id=USER_ID, email="dev@acme.com")
    store.approve_request(request, decided_by="admin-1")
    assert client.tables["organization_members"] == [
        {"org_id": ORG_ID, "user_id": USER_ID, "role": "admin"}
    ]


def test_deny_marks_denied_without_membership() -> None:
    """Denial settles the request and grants nothing."""
    client, store = _store()
    request = store.create_request(org_id=ORG_ID, user_id=USER_ID, email="dev@acme.com")
    decided = store.deny_request(request, decided_by="admin-1")
    assert decided.status == "denied"
    assert client.tables["organization_members"] == []


def test_late_approve_after_deny_grants_nothing() -> None:
    """A decision on an already-denied request returns denied and no access."""
    client, store = _store()
    request = store.create_request(org_id=ORG_ID, user_id=USER_ID, email="dev@acme.com")
    store.deny_request(request, decided_by="admin-1")
    late = store.approve_request(request, decided_by="admin-2")
    assert late.status == "denied"
    assert client.tables["organization_members"] == []
