# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The org-scoped deprovisioning sweep (design E3, core half).

Offboarding a user from one organization is scoped to that org's blast
radius: remove the org membership and (per the org's policy) revoke the
org-scoped API keys the user created. Memberships are many-to-many while
sessions and connections are global to the user, so the user-GLOBAL actions
run only when the deprovisioning org *owns* the identity — a persisted
``account_provenance`` row written when that org's provisioning path created
the ``auth.users`` row itself, never inferred or granted retroactively — or
when the removal leaves the user with zero remaining org memberships.

The sweep is core (it fixes a real offboarding hole for everyone); the SCIM
protocol surface that most often calls it is ``/ee``.

KNOWN GAP, reported honestly instead of faked: the installed Supabase Python
client (``supabase_auth`` 2.31.0) exposes no way to expire another user's
GoTrue sessions — ``auth.admin.sign_out(jwt)`` requires the end user's own
JWT, which a server-side sweep never holds, and no by-user-id logout endpoint
is exposed. ``user_connections`` OAuth credential revocation likewise has no
sanctioned deletion RPC yet. Both surface in ``DeprovisionReport.pending``
and log loudly whenever the sweep owed them.
"""

from __future__ import annotations

import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.routes import ApiError
from explabs.api.tenancy import RequestActor
from explabs.db.repositories import (
    DeleteCapableQuery,
    RepositoryError,
    SupabaseClient,
    find_one_by_columns,
    result_rows,
)
from explabs.db.stores.transitions import now_iso

logger = logging.getLogger(__name__)

type KeyPolicy = Literal["revoke", "keep"]

# The user-global cleanup steps the sweep owes but cannot execute yet; they
# land in DeprovisionReport.pending whenever global cleanup was due.
_PENDING_GLOBAL_ACTIONS = ("gotrue_session_expiry", "user_connections_revocation")


class DeprovisionReport(BaseModel):
    """Exactly what one deprovisioning sweep did and did not do."""

    model_config = ConfigDict(frozen=True)

    org_id: str
    user_id: str
    key_policy: KeyPolicy
    membership_removed: bool
    removed_role: str
    # Ids of org-scoped api_keys created by the user that this sweep revoked
    # (always empty under key_policy='keep').
    keys_revoked: list[str]
    # True when account_provenance names the deprovisioning org as the
    # identity's creator (persisted ownership, never inferred).
    identity_owned_by_org: bool
    remaining_memberships: int
    # Whether the user-global cleanup was due (owned identity, or the removal
    # left zero memberships). Ownerless multi-org users stay membership-scoped.
    global_cleanup_due: bool
    sessions_expired: bool
    # Global steps that were due but not executed; empty means nothing is owed.
    pending: list[str]


def deprovision_user_from_org(
    client: SupabaseClient,
    *,
    org_id: str,
    user_id: str,
    actor: RequestActor | None,
    key_policy: KeyPolicy,
) -> DeprovisionReport:
    """Remove one user from one org and run exactly the cleanup that org owns.

    Args:
        client: Service-role Supabase client.
        org_id: Organization deprovisioning the user.
        user_id: The user being deprovisioned.
        actor: The credential driving the sweep (a SCIM-token actor or an
            admin); ``revoked_by`` is stamped only for human actors.
        key_policy: The org's policy for api_keys the user created: ``revoke``
            stamps ``revoked_at``/``revoked_by``; ``keep`` leaves them live.

    Returns:
        A report listing exactly what was and was not done.

    Raises:
        ApiError: 404 when the user holds no membership in the org; 409 when
            removing them would leave the org without any admin (the
            last-admin guard, mirroring the web-side ``isLastOrgAdmin`` rule).
    """
    membership = find_one_by_columns(
        client, "organization_members", {"org_id": org_id, "user_id": user_id}
    )
    if membership is None:
        msg = f"User {user_id} is not a member of organization {org_id}"
        raise ApiError(msg, status_code=404)
    removed_role = str(membership["role"])

    if removed_role == "admin" and _is_last_admin(client, org_id, user_id):
        msg = "The organization needs at least one admin."
        raise ApiError(msg, status_code=409)

    membership_query = client.table("organization_members")
    if not isinstance(membership_query, DeleteCapableQuery):
        msg = "Supabase query builder does not support delete"
        raise RepositoryError(msg)
    membership_query.delete().eq("org_id", org_id).eq("user_id", user_id).execute()

    keys_revoked: list[str] = []
    match key_policy:
        case "revoke":
            keys_revoked = _revoke_user_created_keys(
                client, org_id=org_id, user_id=user_id, actor=actor
            )
        case "keep":
            pass

    provenance = find_one_by_columns(client, "account_provenance", {"user_id": user_id})
    owned = provenance is not None and str(provenance["provisioned_by_org_id"]) == str(org_id)
    remaining = _remaining_membership_count(client, user_id)
    global_cleanup_due = owned or remaining == 0

    pending: list[str] = []
    if global_cleanup_due:
        # See the module docstring: the Python Supabase client cannot expire
        # another user's GoTrue sessions and user_connections has no deletion
        # RPC yet. Owed cleanup is reported as pending, never silently done.
        pending = list(_PENDING_GLOBAL_ACTIONS)
        logger.warning(
            "Deprovision sweep owes user-global cleanup it cannot execute yet: "
            "user=%s org=%s owned=%s remaining_memberships=%d pending=%s",
            user_id,
            org_id,
            owned,
            remaining,
            pending,
        )

    report = DeprovisionReport(
        org_id=str(org_id),
        user_id=str(user_id),
        key_policy=key_policy,
        membership_removed=True,
        removed_role=removed_role,
        keys_revoked=keys_revoked,
        identity_owned_by_org=owned,
        remaining_memberships=remaining,
        global_cleanup_due=global_cleanup_due,
        sessions_expired=False,
        pending=pending,
    )
    record_audit_event(
        client,
        actor=actor,
        org_id=str(org_id),
        action=AuditAction.MEMBERS_DEPROVISION,
        object_type="member",
        object_id=str(user_id),
        before={"role": removed_role},
        after=report.model_dump(),
    )
    return report


def _is_last_admin(client: SupabaseClient, org_id: str, user_id: str) -> bool:
    """True when the target is the single remaining admin of the org."""
    result = (
        client.table("organization_members")
        .select("user_id")
        .eq("org_id", org_id)
        .eq("role", "admin")
        .execute()
    )
    admins = [str(row["user_id"]) for row in result_rows(result)]
    return len(admins) == 1 and admins[0] == str(user_id)


def _revoke_user_created_keys(
    client: SupabaseClient,
    *,
    org_id: str,
    user_id: str,
    actor: RequestActor | None,
) -> list[str]:
    """Revoke the org's live api_keys created by the user; return their ids."""
    live = (
        client.table("api_keys")
        .select("id")
        .eq("org_id", org_id)
        .eq("created_by", user_id)
        .is_("revoked_at", "null")
        .execute()
    )
    key_ids = [str(row["id"]) for row in result_rows(live)]
    if not key_ids:
        return []
    # revoked_by is a uuid naming a human actor; a SCIM-token or system sweep
    # has none, and the audit row carries the acting credential instead.
    revoked_by = actor.user_id if actor is not None and actor.api_key_org_id is None else None
    client.table("api_keys").update({"revoked_at": now_iso(), "revoked_by": revoked_by}).in_(
        "id", key_ids
    ).execute()
    return key_ids


def _remaining_membership_count(client: SupabaseClient, user_id: str) -> int:
    """Count the org memberships the user still holds after the removal."""
    result = client.table("organization_members").select("org_id").eq("user_id", user_id).execute()
    return len(result_rows(result))
