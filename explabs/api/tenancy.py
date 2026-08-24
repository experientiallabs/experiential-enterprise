# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Per-actor tenant authorization for the platform API.

The deployment bearer key (``EXPLABS_API_KEY``) authenticates the calling
service — the web app, smoke probes — but says nothing about which end user is
acting. Every tenant-scoped route therefore also requires the
``X-Explabs-Actor-Id`` header naming the acting user, asserted by the trusted
caller from its own verified session (the web app forwards the Supabase
session's subject; operational probes assert the seeded platform admin).
Routes then enforce that the actor's organization membership grants the
required role, so a gating bug in one caller can no longer read or mutate
another tenant's data through the service-role backend.

Role semantics: ``user`` reads, creates, and drives work (world models,
uploads, builds, sessions), ``admin`` additionally performs member and
destructive operations. Experiential admins (the ``platform_admins`` table)
operate the deployment across every tenant and pass every org check.

Customer API keys are the second credential the bearer middleware accepts
(org-scoped rows in ``api_keys``, limited to the serving surface). A
key-authenticated request carries no end user: the key itself is the actor,
scoped to its organization at user strength, and any actor header such a
request carries is untrusted and ignored.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Annotated

from fastapi import Header, Request

from explabs.api.routes import ApiError, get_supabase
from explabs.db.repositories import SupabaseClient, find_one_by_columns

ACTOR_HEADER = "X-Explabs-Actor-Id"


class OrgRole(enum.Enum):
    """Organization membership roles, weakest to strongest."""

    USER = "user"
    ADMIN = "admin"


def _role_rank(role: OrgRole) -> int:
    """Return the strength rank of a role for minimum-role comparisons."""
    match role:
        case OrgRole.USER:
            return 0
        case OrgRole.ADMIN:
            return 1


@dataclass(frozen=True)
class RequestActor:
    """The end user a trusted caller is acting for.

    A customer-API-key actor has no end user; ``api_key_org_id`` names the
    single organization the key serves.
    """

    user_id: str
    is_platform_admin: bool
    api_key_org_id: str | None = None
    api_key_id: str | None = None


def require_actor_header(
    actor_id: Annotated[str | None, Header(alias=ACTOR_HEADER)] = None,
) -> str:
    """Require the actor header without resolving platform-admin status.

    For routes that expose no tenant data but keep the every-/api-route header
    contract; skips the platform_admins lookup get_request_actor pays.

    Raises:
        ApiError: 401 when the header is missing or blank.
    """
    if actor_id is None or not actor_id.strip():
        msg = f"{ACTOR_HEADER} header is required"
        raise ApiError(msg, status_code=401)
    return actor_id.strip()


def get_request_actor(
    request: Request,
    actor_id: Annotated[str | None, Header(alias=ACTOR_HEADER)] = None,
) -> RequestActor:
    """Resolve the acting user from the actor header.

    Args:
        request: Current request (provides the Supabase client).
        actor_id: Value of the ``X-Explabs-Actor-Id`` header.

    Returns:
        The request actor, with platform-admin status resolved.

    Raises:
        ApiError: 401 when the header is missing or blank on a request that
            was not authenticated by a customer API key.
    """
    superadmin_user = getattr(request.state, "superadmin_user_id", None)
    if superadmin_user is not None:
        # The middleware authenticated a superadmin key: the key IS the actor
        # (its operator, with platform-admin authority verified at auth time
        # against platform_admins). Any actor header the caller sent is
        # ignored — a machine credential must not impersonate other users.
        return RequestActor(user_id=str(superadmin_user), is_platform_admin=True)
    key_org = getattr(request.state, "api_key_org_id", None)
    if key_org is not None:
        # The middleware authenticated a customer API key. The caller is not
        # a trusted service, so any actor header it sent must not be honored:
        # the key itself is the actor, scoped to its org.
        return RequestActor(
            user_id=f"api-key:{key_org}",
            is_platform_admin=False,
            api_key_org_id=str(key_org),
            api_key_id=str(request.state.api_key_id),
        )
    user_id = require_actor_header(actor_id)
    client = get_supabase(request)
    admin_row = find_one_by_columns(client, "platform_admins", {"user_id": user_id})
    return RequestActor(user_id=user_id, is_platform_admin=admin_row is not None)


def actor_org_role(
    client: SupabaseClient,
    actor: RequestActor,
    org_id: str,
) -> OrgRole | None:
    """Return the actor's role in an organization, if a member."""
    row = find_one_by_columns(
        client,
        "organization_members",
        {"org_id": org_id, "user_id": actor.user_id},
    )
    if row is None:
        return None
    return OrgRole(str(row["role"]))


def require_org_role(
    client: SupabaseClient,
    actor: RequestActor,
    org_id: str,
    minimum: OrgRole,
    *,
    not_found: str,
) -> None:
    """Require that the actor holds at least ``minimum`` role in the org.

    Args:
        client: Supabase client.
        actor: Acting user.
        org_id: Organization owning the target resource.
        minimum: Weakest role that may perform the action.
        not_found: Message for the 404 raised when the actor is not a member,
            phrased as the target resource's not-found error so non-members
            cannot distinguish other tenants' resources from absent ones.

    Raises:
        ApiError: 404 for non-members, 403 for members below ``minimum``.
    """
    if actor.is_platform_admin:
        return
    if actor.api_key_org_id is not None:
        # An API key serves exactly its org, at user strength: reads and
        # session driving, never admin-level operations. Foreign orgs get the
        # resource's 404, indistinguishable from an absent id.
        if str(org_id) != actor.api_key_org_id:
            raise ApiError(not_found, status_code=404)
        if _role_rank(minimum) > _role_rank(OrgRole.USER):
            msg = "API keys do not permit this action"
            raise ApiError(msg, status_code=403)
        return
    role = actor_org_role(client, actor, org_id)
    if role is None:
        raise ApiError(not_found, status_code=404)
    if _role_rank(role) < _role_rank(minimum):
        msg = f"Role {role.value!r} does not permit this action"
        raise ApiError(msg, status_code=403)


def require_platform_admin(actor: RequestActor) -> None:
    """Require that the actor operates the deployment rather than one tenant.

    The gate for cross-org operator surfaces (the runs panel, the per-call
    routing audit): they read every tenant's data and answer questions the
    product deliberately does not answer for tenants, so org membership is not
    a qualification for them at any role.

    Args:
        actor: Acting user.

    Raises:
        ApiError: 404 for everyone else. Not 403: a forbidden response would
            confirm the surface exists, and an operator panel must not be
            enumerable from a tenant session.
    """
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)


def actor_org_ids(client: SupabaseClient, actor: RequestActor) -> set[str]:
    """Return the ids of the organizations the actor belongs to."""
    if actor.api_key_org_id is not None:
        return {actor.api_key_org_id}
    result = (
        client.table("organization_members").select("org_id").eq("user_id", actor.user_id).execute()
    )
    return {str(row["org_id"]) for row in result.data}


def resolve_acting_org(client: SupabaseClient, actor: RequestActor) -> str:
    """Return the single organization an actor's credential acts for.

    Shared by the actor-scoped reads that carry no org id in the path
    (``/api/whoami``, ``/api/keys``): an ``xpl_`` org key names exactly its org,
    and a session actor with one membership resolves to it. An actor spanning
    several orgs (multiple memberships, or a platform admin who acts across every
    org) has no single answer, so the 409 names the fix rather than guessing.

    Args:
        client: Supabase client.
        actor: Acting user or key.

    Returns:
        The id of the one organization the credential acts for.

    Raises:
        ApiError: 409 when the actor spans several orgs or operates the whole
            deployment; 404 when the actor holds no membership.
    """
    if actor.api_key_org_id is not None:
        return actor.api_key_org_id
    if actor.is_platform_admin:
        msg = (
            "Platform admins act across every organization; call an "
            "org-scoped endpoint or use an organization API key"
        )
        raise ApiError(msg, status_code=409)
    org_ids = sorted(actor_org_ids(client, actor))
    if not org_ids:
        msg = "No organization membership for this actor"
        raise ApiError(msg, status_code=404)
    if len(org_ids) > 1:
        msg = (
            "Actor belongs to multiple organizations; call an org-scoped "
            "endpoint or use an organization API key"
        )
        raise ApiError(msg, status_code=409)
    return org_ids[0]
