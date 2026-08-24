# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the org-labels and admin-notes store."""

from __future__ import annotations

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.org_label_store import OrgLabelStore


def _store() -> tuple[OrgLabelStore, FakeSupabaseClient]:
    client = FakeSupabaseClient()
    client.tables["org_labels"] = []
    client.tables["org_admin_notes"] = []
    return OrgLabelStore(client), client


def test_add_label_is_idempotent() -> None:
    """A second add of the same (org, key) returns the row without duplicating."""
    store, client = _store()
    first = store.add_label("org-1", "yc", "admin-1")
    second = store.add_label("org-1", "yc", "admin-2")
    assert first.key == "yc"
    assert second.id == first.id
    assert len(client.tables["org_labels"]) == 1


def test_remove_label_is_idempotent() -> None:
    """Removing an absent label is a no-op, not an error."""
    store, client = _store()
    store.add_label("org-1", "yc", "admin-1")
    store.remove_label("org-1", "yc")
    store.remove_label("org-1", "yc")
    assert client.tables["org_labels"] == []


def test_list_and_batch_labels() -> None:
    """Per-org listing and the batch map both reflect current labels."""
    store, _ = _store()
    store.add_label("org-1", "yc", "admin-1")
    store.add_label("org-1", "beta", "admin-1")
    store.add_label("org-2", "yc", "admin-1")
    assert {label.key for label in store.list_labels("org-1")} == {"yc", "beta"}
    batch = store.labels_by_org()
    assert set(batch["org-1"]) == {"yc", "beta"}
    assert batch["org-2"] == ["yc"]


def test_notes_add_list_newest_first_and_delete() -> None:
    """Notes are author-attributed, listed newest first, and deletable."""
    store, client = _store()
    client.tables["org_admin_notes"] = [
        {
            "id": "note-old",
            "org_id": "org-1",
            "author_user_id": "admin-1",
            "author_email": "a@x.example",
            "body": "older",
            "created_at": "2026-08-01T00:00:00Z",
            "updated_at": "2026-08-01T00:00:00Z",
        },
    ]
    added = store.add_note("org-1", "admin-2", "b@x.example", "newer")
    assert added.author_email == "b@x.example"
    notes = store.list_notes("org-1")
    assert [note.body for note in notes] == ["newer", "older"]
    # Delete is scoped to the note's org: a mismatched org never deletes.
    assert store.delete_note("org-2", added.id) is None
    assert {note.id for note in store.list_notes("org-1")} == {added.id, "note-old"}
    deleted = store.delete_note("org-1", added.id)
    assert deleted is not None
    assert store.delete_note("org-1", "no-such-note") is None


def test_resolve_author_email_reads_verification_rpc() -> None:
    """The acting admin's email is resolved via auth_user_verification."""
    store, client = _store()
    client.tables["auth_users"] = [{"id": "admin-1", "email": "admin@explabs.example"}]
    assert store.resolve_author_email("admin-1") == "admin@explabs.example"
    assert store.resolve_author_email("nobody") is None
