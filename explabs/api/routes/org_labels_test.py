# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the admin org-labels and admin-notes routes."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.conftest import OPERATOR_ID, ORG_ID, OTHER_ORG_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient

_ADMIN = {"X-Explabs-Actor-Id": OPERATOR_ID}


def _seed(supabase: FakeSupabaseClient) -> None:
    supabase.tables["org_labels"] = []
    supabase.tables["org_admin_notes"] = []
    # The acting admin's email, resolved for note attribution.
    supabase.tables["auth_users"] = [
        {"id": OPERATOR_ID, "email": "operator@explabs.example"},
    ]


# -- Labels ----------------------------------------------------------------


def test_labels_require_platform_admin(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Every label surface is a not-found to a non-admin actor."""
    _seed(supabase)
    assert api.get(f"/api/admin/orgs/{ORG_ID}/labels").status_code == 404
    assert api.post(f"/api/admin/orgs/{ORG_ID}/labels", json={"key": "yc"}).status_code == 404
    assert api.get("/api/admin/orgs/labels").status_code == 404


def test_add_list_and_remove_label(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """An admin can apply, list, and remove a label; add is idempotent."""
    _seed(supabase)
    created = api.post(f"/api/admin/orgs/{ORG_ID}/labels", json={"key": "yc"}, headers=_ADMIN)
    assert created.status_code == 201
    assert created.json()["key"] == "yc"
    # Idempotent: a second add does not duplicate.
    again = api.post(f"/api/admin/orgs/{ORG_ID}/labels", json={"key": "yc"}, headers=_ADMIN)
    assert again.status_code == 201
    listed = api.get(f"/api/admin/orgs/{ORG_ID}/labels", headers=_ADMIN)
    assert [label["key"] for label in listed.json()["labels"]] == ["yc"]
    removed = api.delete(f"/api/admin/orgs/{ORG_ID}/labels/yc", headers=_ADMIN)
    assert removed.status_code == 200
    assert api.get(f"/api/admin/orgs/{ORG_ID}/labels", headers=_ADMIN).json()["labels"] == []


def test_add_label_bad_key_is_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A label key outside the slug shape is refused before any write."""
    _seed(supabase)
    response = api.post(
        f"/api/admin/orgs/{ORG_ID}/labels", json={"key": "Not A Slug"}, headers=_ADMIN
    )
    assert response.status_code == 400
    assert supabase.tables["org_labels"] == []


def test_add_label_unknown_org_is_404(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Labeling a nonexistent org is a not-found."""
    _seed(supabase)
    response = api.post("/api/admin/orgs/no-such-org/labels", json={"key": "yc"}, headers=_ADMIN)
    assert response.status_code == 404


def test_labels_batch_map(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The batch endpoint returns a map of org_id -> label keys."""
    _seed(supabase)
    api.post(f"/api/admin/orgs/{ORG_ID}/labels", json={"key": "yc"}, headers=_ADMIN)
    api.post(f"/api/admin/orgs/{OTHER_ORG_ID}/labels", json={"key": "beta"}, headers=_ADMIN)
    batch = api.get("/api/admin/orgs/labels", headers=_ADMIN)
    assert batch.status_code == 200
    labels = batch.json()["labels"]
    assert labels[ORG_ID] == ["yc"]
    assert labels[OTHER_ORG_ID] == ["beta"]


def test_labels_reachable_by_superadmin_key(
    superadmin_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An xpladmin_ key reaches the label surface exactly like a session admin."""
    _seed(supabase)
    created = superadmin_api.post(f"/api/admin/orgs/{ORG_ID}/labels", json={"key": "yc"})
    assert created.status_code == 201
    assert created.json()["key"] == "yc"


# -- Notes -----------------------------------------------------------------


def test_notes_require_platform_admin(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Every note surface is a not-found to a non-admin actor."""
    _seed(supabase)
    assert api.get(f"/api/admin/orgs/{ORG_ID}/notes").status_code == 404
    assert api.post(f"/api/admin/orgs/{ORG_ID}/notes", json={"body": "hi"}).status_code == 404


def test_add_list_and_delete_note(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A note is author-attributed with the acting admin's email, then deletable."""
    _seed(supabase)
    created = api.post(
        f"/api/admin/orgs/{ORG_ID}/notes", json={"body": "  internal note  "}, headers=_ADMIN
    )
    assert created.status_code == 201
    note = created.json()
    assert note["body"] == "internal note"
    assert note["author_user_id"] == OPERATOR_ID
    assert note["author_email"] == "operator@explabs.example"
    listed = api.get(f"/api/admin/orgs/{ORG_ID}/notes", headers=_ADMIN)
    assert [row["body"] for row in listed.json()["notes"]] == ["internal note"]
    removed = api.delete(f"/api/admin/orgs/{ORG_ID}/notes/{note['id']}", headers=_ADMIN)
    assert removed.status_code == 200
    assert api.get(f"/api/admin/orgs/{ORG_ID}/notes", headers=_ADMIN).json()["notes"] == []


def test_add_empty_note_is_400(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A blank note body is refused before the store is touched."""
    _seed(supabase)
    response = api.post(f"/api/admin/orgs/{ORG_ID}/notes", json={"body": "   "}, headers=_ADMIN)
    assert response.status_code in (400, 422)
    assert supabase.tables["org_admin_notes"] == []


def test_add_note_unresolvable_email_is_409(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A note cannot be attributed when the admin's email cannot be resolved."""
    _seed(supabase)
    supabase.tables["auth_users"] = []
    response = api.post(f"/api/admin/orgs/{ORG_ID}/notes", json={"body": "hi"}, headers=_ADMIN)
    assert response.status_code == 409
    assert supabase.tables["org_admin_notes"] == []


def test_delete_missing_note_is_404(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """Deleting an unknown note id is a not-found."""
    _seed(supabase)
    response = api.delete(f"/api/admin/orgs/{ORG_ID}/notes/no-such-note", headers=_ADMIN)
    assert response.status_code == 404


def test_delete_note_through_mismatched_org_is_404(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A note deletes only through its own org: another org's URL is a not-found."""
    _seed(supabase)
    created = api.post(
        f"/api/admin/orgs/{ORG_ID}/notes", json={"body": "internal note"}, headers=_ADMIN
    )
    note_id = created.json()["id"]
    # Deleting the ORG_ID note through OTHER_ORG_ID must not touch it.
    response = api.delete(f"/api/admin/orgs/{OTHER_ORG_ID}/notes/{note_id}", headers=_ADMIN)
    assert response.status_code == 404
    listed = api.get(f"/api/admin/orgs/{ORG_ID}/notes", headers=_ADMIN)
    assert [row["id"] for row in listed.json()["notes"]] == [note_id]
    # The correct org still deletes it.
    ok = api.delete(f"/api/admin/orgs/{ORG_ID}/notes/{note_id}", headers=_ADMIN)
    assert ok.status_code == 200
    assert api.get(f"/api/admin/orgs/{ORG_ID}/notes", headers=_ADMIN).json()["notes"] == []
