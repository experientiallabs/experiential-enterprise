# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed admin access to org special-attribute labels and internal admin notes.

Two admin-only data surfaces on an organization:

* ``public.org_labels`` -- extensible per-org badges. The DB stores an arbitrary
  slug; the display text and color live in web code, so a new label kind needs
  no migration. Writes ride the ``add_org_label`` / ``remove_org_label`` SECURITY
  DEFINER functions (idempotent); reads select the table directly on the service
  role.
* ``public.org_admin_notes`` -- internal, platform-admin-only notes on an org,
  each author-attributed. Writes ride ``add_org_admin_note`` /
  ``delete_org_admin_note``; reads select directly, newest first.

Author-email resolution reuses ``auth_user_verification`` (service-role /
platform-admin definer read that returns the user's email); the note table
denormalizes it because there is no auth.users foreign key to join through.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import (
    JsonObject,
    SupabaseClient,
    first_row,
    result_rows,
)

_POSTGREST_PAGE_SIZE = 1000


class OrgLabel(BaseModel):
    """Typed snapshot of one org label row."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    key: str
    created_by: str
    created_at: str

    def api_view(self) -> JsonObject:
        """The admin-panel projection."""
        return {
            "id": self.id,
            "org_id": self.org_id,
            "key": self.key,
            "created_by": self.created_by,
            "created_at": self.created_at,
        }


class OrgAdminNote(BaseModel):
    """Typed snapshot of one internal admin note."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    author_user_id: str
    author_email: str
    body: str
    created_at: str
    updated_at: str

    def api_view(self) -> JsonObject:
        """The admin-panel projection."""
        return {
            "id": self.id,
            "org_id": self.org_id,
            "author_user_id": self.author_user_id,
            "author_email": self.author_email,
            "body": self.body,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class OrgLabelStore:
    """Admin reads and writes over org labels and internal admin notes."""

    def __init__(self, client: SupabaseClient) -> None:
        """Wrap a service-role Supabase client (admin writes bypass RLS)."""
        self._client = client

    # -- Labels ------------------------------------------------------------

    def list_labels(self, org_id: str) -> list[OrgLabel]:
        """Return one org's labels, oldest first (stable badge order)."""
        result = (
            self._client.table("org_labels")
            .select("*")
            .eq("org_id", org_id)
            .order("created_at")
            .execute()
        )
        return [OrgLabel.model_validate(row) for row in result_rows(result)]

    def labels_by_org(self) -> dict[str, list[str]]:
        """Return a map of org_id -> its label keys, for the org-list badges.

        One paged read over the whole table, so the org list joins labels in
        code without an N+1 per row.
        """
        grouped: dict[str, list[str]] = {}
        for row in self._paged_rows("org_labels", "org_id, key", ("org_id", "key")):
            grouped.setdefault(str(row["org_id"]), []).append(str(row["key"]))
        return grouped

    def add_label(self, org_id: str, key: str, admin_id: str) -> OrgLabel:
        """Apply a label to an org (idempotent on conflict)."""
        result = self._client.rpc(
            "add_org_label",
            {"in_org": org_id, "in_key": key, "in_admin": admin_id},
        ).execute()
        row = first_row(result, context=f"add_org_label for {org_id!r}/{key!r}")
        return OrgLabel.model_validate(row)

    def remove_label(self, org_id: str, key: str) -> None:
        """Remove a label from an org (idempotent)."""
        self._client.rpc(
            "remove_org_label",
            {"in_org": org_id, "in_key": key},
        ).execute()

    # -- Notes -------------------------------------------------------------

    def list_notes(self, org_id: str) -> list[OrgAdminNote]:
        """Return one org's admin notes, newest first."""
        result = (
            self._client.table("org_admin_notes")
            .select("*")
            .eq("org_id", org_id)
            .order("created_at", desc=True)
            .execute()
        )
        return [OrgAdminNote.model_validate(row) for row in result_rows(result)]

    def add_note(self, org_id: str, author_id: str, author_email: str, body: str) -> OrgAdminNote:
        """Post an author-attributed internal note on an org."""
        result = self._client.rpc(
            "add_org_admin_note",
            {
                "in_org": org_id,
                "in_author": author_id,
                "in_author_email": author_email,
                "in_body": body,
            },
        ).execute()
        row = first_row(result, context=f"add_org_admin_note for {org_id!r}")
        return OrgAdminNote.model_validate(row)

    def delete_note(self, org_id: str, note_id: str) -> OrgAdminNote | None:
        """Delete a note scoped to (org_id, note_id).

        Returns the deleted row, or None when no note with that id belongs to
        the org (a mismatched org is a not-found, never a cross-org delete).
        """
        result = self._client.rpc(
            "delete_org_admin_note",
            {"in_org": org_id, "in_note": note_id},
        ).execute()
        rows = result_rows(result)
        return OrgAdminNote.model_validate(rows[0]) if rows else None

    def resolve_author_email(self, user_id: str) -> str | None:
        """Resolve an acting admin's email for note attribution.

        Reuses ``auth_user_verification`` (a definer read returning the user's
        email); the note author is always the acting platform admin, whose
        account exists.
        """
        result = self._client.rpc(
            "auth_user_verification",
            {"target_user_id": user_id},
        ).execute()
        rows = result_rows(result)
        if not rows:
            return None
        email = rows[0].get("email")
        return str(email) if email is not None else None

    def _paged_rows(self, table: str, columns: str, order: tuple[str, ...]) -> list[JsonObject]:
        """Fetch a whole table past the PostgREST row cap (stable total order)."""
        rows: list[JsonObject] = []
        offset = 0
        while True:
            query = self._client.table(table).select(columns)
            for column in order:
                query = query.order(column)
            result = query.range(offset, offset + _POSTGREST_PAGE_SIZE - 1).execute()
            page = list(result_rows(result))
            rows.extend(page)
            if len(page) < _POSTGREST_PAGE_SIZE:
                return rows
            offset += _POSTGREST_PAGE_SIZE
