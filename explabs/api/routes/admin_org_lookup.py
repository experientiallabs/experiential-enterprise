# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Operator organization lookups and edits (superadmin).

Per-org admin actions — tags, credit grants, the welcome trigger — key on
``org_id``, but operators hold founder emails. ``resolve-emails`` maps email ->
org(s) through the ``admin_orgs_for_emails`` definer function (which reads
``auth.users``), so an operator can drive those actions by email through the
admin API instead of touching the database directly. The rename endpoint lets an
operator set an org's display name (and slug), e.g. renaming an auto-provisioned
personal org to the company it belongs to.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, field_validator

from explabs.api.credits import load_organization
from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import RequestActor, get_request_actor, require_platform_admin
from explabs.db.repositories import JsonObject, SupabaseClient, update_by_id

router = APIRouter(prefix="/api", tags=["admin-org-lookup"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]


_MAX_EMAILS = 500


class ResolveEmailsBody(BaseModel):
    """Operator request: the founder emails to resolve to their orgs."""

    model_config = ConfigDict(frozen=True)

    emails: list[str]

    @field_validator("emails")
    @classmethod
    def _clean(cls, value: list[str]) -> list[str]:
        # Trim each pasted address (leading/trailing whitespace otherwise defeats
        # the lowercase-only SQL match and silently drops the founder) and bound
        # the batch so a huge paste gets a clear error, not unbounded DB work.
        cleaned = [email.strip() for email in value if email.strip()]
        if not cleaned:
            msg = "emails must contain at least one address"
            raise ValueError(msg)
        if len(cleaned) > _MAX_EMAILS:
            msg = f"emails must not exceed {_MAX_EMAILS} per request"
            raise ValueError(msg)
        return cleaned


@router.post("/admin/orgs/resolve-emails")
def resolve_emails_to_orgs(
    body: ResolveEmailsBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Resolve each email to the org(s) that email belongs to (superadmin).

    Returns one entry per REQUESTED email (empty ``orgs`` when the email matches
    no account), so a caller can spot founders who have not signed up yet. Each
    org carries the caller's membership ``role`` so the backfill can prefer the
    org the founder owns (``admin``).
    """
    require_platform_admin(actor)
    result = client.rpc("admin_orgs_for_emails", {"in_emails": list(body.emails)}).execute()
    rows: list[JsonObject] = list(result.data or [])
    by_email: dict[str, list[JsonObject]] = {}
    for row in rows:
        by_email.setdefault(str(row["email"]).lower(), []).append(
            {
                "org_id": str(row["org_id"]),
                "slug": row.get("org_slug"),
                "name": row.get("org_name"),
                "role": row.get("member_role"),
            }
        )
    return {
        "results": [
            {"email": email, "orgs": by_email.get(email.lower(), [])} for email in body.emails
        ]
    }


class RenameOrgBody(BaseModel):
    """Operator request to rename an org's display name (and optionally slug)."""

    model_config = ConfigDict(frozen=True)

    name: str
    # Optional new URL slug; the caller ensures it is free (slug is unique).
    slug: str | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        if not value.strip():
            msg = "name must not be blank"
            raise ValueError(msg)
        return value.strip()

    @field_validator("slug")
    @classmethod
    def _slug_shape(cls, value: str | None) -> str | None:
        if value is None:
            return None
        slug = value.strip().lower()
        if not slug or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in slug):
            msg = "slug must be lowercase alphanumeric with hyphens"
            raise ValueError(msg)
        return slug


@router.put("/admin/orgs/{org_id}/rename")
def rename_org(
    org_id: str,
    body: RenameOrgBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Set an org's display name, and optionally its slug (superadmin).

    Used to rename an auto-provisioned personal org to the company it belongs to.
    The slug is unique, so a colliding slug surfaces as a conflict; the caller is
    expected to pass a free slug (or omit it to change the name only).
    """
    require_platform_admin(actor)
    load_organization(client, org_id)
    changes: JsonObject = {"name": body.name, "updated_at": datetime.now(UTC).isoformat()}
    if body.slug is not None:
        changes["slug"] = body.slug
    try:
        update_by_id(client, "organizations", org_id, changes)
    except Exception as exc:  # a slug collision is the expected failure here
        message = str(exc)
        if "duplicate" in message.lower() or "unique" in message.lower():
            conflict = "slug is already taken"
            raise ApiError(conflict, status_code=409) from exc
        raise
    return {"org_id": org_id, "name": body.name, "slug": body.slug}
