# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Admin CRUD for org special-attribute labels and internal admin notes.

Platform-admin surface behind the dashboard admin panel and the ``xpladmin_``
superadmin keys. Labels are extensible per-org badges (the DB stores a slug; the
display text and color live in web code); notes are internal, author-attributed
records only platform admins ever see. Anyone who is not a platform admin gets
the standard not-found, exactly like the other admin routes.
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import RequestActor, get_request_actor
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.org_label_store import OrgLabelStore

router = APIRouter(prefix="/api", tags=["org-labels"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# The label-key slug shape, mirrored from the SQL check
# (org_labels_key_check / public.org_label_keys_valid).
_LABEL_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")

_NOTE_MAX_LENGTH = 4000


class OrgLabelBody(BaseModel):
    """Body of the label create write."""

    key: str = Field(min_length=1)


class OrgAdminNoteBody(BaseModel):
    """Body of the note create write."""

    body: str = Field(min_length=1)


def _require_admin(actor: RequestActor) -> None:
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)


def _validate_label_key(key: str) -> str:
    """Refuse a malformed label key before touching the store."""
    normalized = key.strip()
    if not _LABEL_KEY_PATTERN.match(normalized):
        msg = "label key must match ^[a-z][a-z0-9-]{0,31}$"
        raise ApiError(msg, status_code=400)
    return normalized


@router.get("/admin/orgs/labels")
def list_all_org_labels(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Return a map of org_id -> label keys, for the admin org-list badges."""
    _require_admin(actor)
    return {"labels": OrgLabelStore(client).labels_by_org()}


@router.get("/admin/orgs/{org_id}/labels")
def list_org_labels(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """List one org's labels."""
    _require_admin(actor)
    labels = OrgLabelStore(client).list_labels(org_id)
    return {"labels": [label.api_view() for label in labels]}


@router.post("/admin/orgs/{org_id}/labels", status_code=201)
def add_org_label(
    org_id: str,
    body: OrgLabelBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Apply a label to an org (idempotent)."""
    _require_admin(actor)
    load_org_row(client, org_id)
    key = _validate_label_key(body.key)
    label = OrgLabelStore(client).add_label(org_id, key, actor.user_id)
    return label.api_view()


@router.delete("/admin/orgs/{org_id}/labels/{key}")
def remove_org_label(
    org_id: str,
    key: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Remove a label from an org (idempotent)."""
    _require_admin(actor)
    OrgLabelStore(client).remove_label(org_id, key)
    return {"ok": True}


@router.get("/admin/orgs/{org_id}/notes")
def list_org_notes(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """List one org's internal admin notes, newest first."""
    _require_admin(actor)
    notes = OrgLabelStore(client).list_notes(org_id)
    return {"notes": [note.api_view() for note in notes]}


@router.post("/admin/orgs/{org_id}/notes", status_code=201)
def add_org_note(
    org_id: str,
    body: OrgAdminNoteBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Post an author-attributed internal note on an org.

    The author is the acting admin, resolved from the request actor: the user id
    is on the actor, and the email is resolved in the store (the note table
    denormalizes it since there is no auth.users FK to join through).
    """
    _require_admin(actor)
    load_org_row(client, org_id)
    text = body.body.strip()
    if not text:
        msg = "note body must be non-empty"
        raise ApiError(msg, status_code=400)
    if len(text) > _NOTE_MAX_LENGTH:
        msg = f"note body must be at most {_NOTE_MAX_LENGTH} characters"
        raise ApiError(msg, status_code=400)
    store = OrgLabelStore(client)
    author_email = store.resolve_author_email(actor.user_id)
    if author_email is None:
        msg = "could not resolve the acting admin's email for note attribution"
        raise ApiError(msg, status_code=409)
    note = store.add_note(org_id, actor.user_id, author_email, text)
    return note.api_view()


@router.delete("/admin/orgs/{org_id}/notes/{note_id}")
def delete_org_note(
    org_id: str,
    note_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Delete an internal admin note, scoped to its org."""
    _require_admin(actor)
    deleted = OrgLabelStore(client).delete_note(org_id, note_id)
    if deleted is None:
        msg = f"No note with id {note_id!r}"
        raise ApiError(msg, status_code=404)
    return {"ok": True}
