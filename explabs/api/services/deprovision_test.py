# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the org-scoped deprovisioning sweep."""

from __future__ import annotations

from typing import cast

import pytest

from explabs.api.routes import ApiError
from explabs.api.services.deprovision import DeprovisionReport, deprovision_user_from_org
from explabs.api.tenancy import RequestActor
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import SupabaseClient

ORG_A = "org-a"
ORG_B = "org-b"
ADMIN_ID = "user-admin"
TARGET_ID = "user-target"
OTHER_USER_ID = "user-other"

_ADMIN_ACTOR = RequestActor(user_id=ADMIN_ID, is_platform_admin=False)
_SCIM_ACTOR = RequestActor(
    user_id=f"scim:{ORG_A}",
    is_platform_admin=False,
    api_key_org_id=ORG_A,
    api_key_id=f"scim-token:{ORG_A}",
)


def _client() -> FakeSupabaseClient:
    """A fake seeded with two orgs, a multi-org target, and their keys."""
    client = FakeSupabaseClient()
    client.tables["organizations"] = [
        {"id": ORG_A, "slug": "org-a", "name": "Org A"},
        {"id": ORG_B, "slug": "org-b", "name": "Org B"},
    ]
    client.tables["organization_members"] = [
        {"org_id": ORG_A, "user_id": ADMIN_ID, "role": "admin"},
        {"org_id": ORG_A, "user_id": TARGET_ID, "role": "user"},
        {"org_id": ORG_B, "user_id": TARGET_ID, "role": "user"},
    ]
    client.tables["api_keys"] = [
        {
            "id": "key-target-live",
            "org_id": ORG_A,
            "name": "target's key",
            "key_prefix": "xpl_t1",
            "key_hash": "a" * 64,
            "created_by": TARGET_ID,
            "created_at": "2026-08-01T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            "revoked_by": None,
            "expires_at": None,
        },
        {
            "id": "key-target-already-revoked",
            "org_id": ORG_A,
            "name": "already revoked",
            "key_prefix": "xpl_t2",
            "key_hash": "b" * 64,
            "created_by": TARGET_ID,
            "created_at": "2026-08-01T00:00:00Z",
            "last_used_at": None,
            "revoked_at": "2026-08-02T00:00:00Z",
            "revoked_by": None,
            "expires_at": None,
        },
        {
            "id": "key-other-user",
            "org_id": ORG_A,
            "name": "someone else's key",
            "key_prefix": "xpl_o1",
            "key_hash": "c" * 64,
            "created_by": OTHER_USER_ID,
            "created_at": "2026-08-01T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            "revoked_by": None,
            "expires_at": None,
        },
        {
            "id": "key-target-other-org",
            "org_id": ORG_B,
            "name": "target's org-b key",
            "key_prefix": "xpl_t3",
            "key_hash": "d" * 64,
            "created_by": TARGET_ID,
            "created_at": "2026-08-01T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
            "revoked_by": None,
            "expires_at": None,
        },
    ]
    client.tables["account_provenance"] = []
    return client


def _sweep(
    client: FakeSupabaseClient,
    *,
    org_id: str = ORG_A,
    user_id: str = TARGET_ID,
    actor: RequestActor | None = _ADMIN_ACTOR,
    key_policy: str = "revoke",
) -> DeprovisionReport:
    """Run the sweep against the fake with test defaults."""
    return deprovision_user_from_org(
        cast("SupabaseClient", client),
        org_id=org_id,
        user_id=user_id,
        actor=actor,
        key_policy="revoke" if key_policy == "revoke" else "keep",
    )


def _key(client: FakeSupabaseClient, key_id: str) -> dict[str, object]:
    """Fetch one seeded api_keys row by id."""
    return next(row for row in client.tables["api_keys"] if row["id"] == key_id)


def test_sweep_scopes_to_the_calling_orgs_blast_radius() -> None:
    """Membership and keys go in the calling org only; other orgs untouched."""
    client = _client()
    report = _sweep(client)

    assert report.membership_removed is True
    assert report.keys_revoked == ["key-target-live"]
    memberships = client.tables["organization_members"]
    assert {"org_id": ORG_A, "user_id": TARGET_ID, "role": "user"} not in memberships
    assert any(m["org_id"] == ORG_B and m["user_id"] == TARGET_ID for m in memberships)

    revoked = _key(client, "key-target-live")
    assert revoked["revoked_at"] is not None
    assert revoked["revoked_by"] == ADMIN_ID
    assert _key(client, "key-other-user")["revoked_at"] is None
    assert _key(client, "key-target-other-org")["revoked_at"] is None


def test_keep_policy_leaves_keys_live() -> None:
    """key_policy='keep' removes the membership but revokes nothing."""
    client = _client()
    report = _sweep(client, key_policy="keep")
    assert report.keys_revoked == []
    assert _key(client, "key-target-live")["revoked_at"] is None


def test_scim_actor_revokes_without_a_human_revoked_by() -> None:
    """A SCIM-token sweep stamps revoked_at but no revoked_by uuid."""
    client = _client()
    report = _sweep(client, actor=_SCIM_ACTOR)
    assert report.keys_revoked == ["key-target-live"]
    revoked = _key(client, "key-target-live")
    assert revoked["revoked_at"] is not None
    assert revoked["revoked_by"] is None


def test_last_admin_guard_refuses_to_orphan_the_org() -> None:
    """Removing the org's final admin is a 409, mirroring the web-side rule."""
    client = _client()
    with pytest.raises(ApiError) as error:
        _sweep(client, user_id=ADMIN_ID, actor=_SCIM_ACTOR)
    assert error.value.status_code == 409
    memberships = client.tables["organization_members"]
    assert any(m["user_id"] == ADMIN_ID for m in memberships)


def test_second_admin_can_be_deprovisioned() -> None:
    """An admin who is not the last one is removable like anyone else."""
    client = _client()
    client.tables["organization_members"].append(
        {"org_id": ORG_A, "user_id": OTHER_USER_ID, "role": "admin"}
    )
    report = _sweep(client, user_id=OTHER_USER_ID)
    assert report.membership_removed is True
    assert report.removed_role == "admin"


def test_non_member_is_a_404() -> None:
    """Deprovisioning someone who holds no membership names the absence."""
    client = _client()
    with pytest.raises(ApiError) as error:
        _sweep(client, user_id="user-nobody")
    assert error.value.status_code == 404


def test_ownerless_multi_org_user_gets_no_global_cleanup() -> None:
    """No provenance + remaining memberships => membership-scoped only."""
    client = _client()
    report = _sweep(client)
    assert report.identity_owned_by_org is False
    assert report.remaining_memberships == 1
    assert report.global_cleanup_due is False
    assert report.pending == []


def test_owned_identity_owes_global_cleanup_and_reports_it_pending(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Persisted ownership triggers global cleanup, reported pending not faked."""
    client = _client()
    client.tables["account_provenance"] = [
        {"user_id": TARGET_ID, "provisioned_by_org_id": ORG_A, "provisioned_via": "scim"},
    ]
    with caplog.at_level("WARNING"):
        report = _sweep(client, actor=_SCIM_ACTOR)
    assert report.identity_owned_by_org is True
    assert report.global_cleanup_due is True
    assert report.sessions_expired is False
    assert report.pending == ["gotrue_session_expiry", "user_connections_revocation"]
    assert any("owes user-global cleanup" in message for message in caplog.messages)


def test_ownership_by_a_different_org_does_not_leak_global_cleanup() -> None:
    """Another org's ownership never widens this org's blast radius."""
    client = _client()
    client.tables["account_provenance"] = [
        {"user_id": TARGET_ID, "provisioned_by_org_id": ORG_B, "provisioned_via": "scim"},
    ]
    report = _sweep(client)
    assert report.identity_owned_by_org is False
    assert report.global_cleanup_due is False


def test_zero_remaining_memberships_triggers_global_cleanup_regardless() -> None:
    """The zero-memberships exception applies even to ownerless accounts."""
    client = _client()
    client.tables["organization_members"] = [
        {"org_id": ORG_A, "user_id": ADMIN_ID, "role": "admin"},
        {"org_id": ORG_A, "user_id": TARGET_ID, "role": "user"},
    ]
    report = _sweep(client)
    assert report.remaining_memberships == 0
    assert report.global_cleanup_due is True
    assert report.pending == ["gotrue_session_expiry", "user_connections_revocation"]


def test_every_sweep_emits_the_members_deprovision_audit_event() -> None:
    """The audit seam fires once per sweep with the full report attached."""
    client = _client()
    _sweep(client)
    assert client.executed_rpcs.count("record_audit_event") == 1
