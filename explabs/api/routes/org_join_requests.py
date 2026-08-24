# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Domain-based organization join requests.

Three surfaces over ``explabs/db/stores/org_join_store.py``:

* Requester (acts for the signed-in user, no org in the path): read the
  domain-match offer, and open a request to join the org their verified email
  domain maps to. Their own personal org is untouched -- this only asks for
  access to an existing org.
* Org admin (org-scoped): list pending requests and approve/deny; approval
  grants membership through the shared ``organization_members`` path.
* Platform admin: CRUD the operator-controlled domain -> org associations. A
  domain is never self-asserted by a tenant, so this is a platform-admin-only
  write surface.

Every route is deployment-key gated and, past that, actor-gated. NONE are in
``app.py``'s ``_CUSTOMER_KEY_ROUTES`` allowlist: a customer ``xpl_`` key carries
no end user and must never reach the requester or admin paths.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import (
    OrgRole,
    RequestActor,
    get_request_actor,
    require_org_role,
    require_platform_admin,
)
from explabs.db.repositories import JsonObject, SupabaseClient, find_one_by_columns
from explabs.db.stores.org_join_store import (
    DuplicateOrgDomainError,
    DuplicatePendingRequestError,
    JoinRequestRecord,
    OrgJoinStore,
    email_domain,
)

router = APIRouter(prefix="/api", tags=["org join requests"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

_KEY_ACTOR_MSG = "Join requests require a signed-in user, not an API key."
_UNVERIFIED_MSG = "Confirm your email before requesting organization access."
_NO_DOMAIN_ORG_MSG = "No organization is registered for your email domain."
_NO_ACCOUNT_MSG = "No account found for this user."
_ALREADY_MEMBER_MSG = "You already belong to this organization."
_PENDING_EXISTS_MSG = "You already have a pending request for this organization."
_BAD_DOMAIN_MSG = "Provide a bare domain such as 'example.com'."
_ORG_BANNED_MSG = "This organization is banned; join requests cannot be approved."


# -- Response shapes --------------------------------------------------------


class JoinOfferView(BaseModel):
    """The domain-match offer shown to a signed-in user, if any."""

    model_config = ConfigDict(extra="forbid")

    org_id: str
    org_name: str
    org_slug: str
    # Whether the requester's email is confirmed; the request button stays
    # disabled until it is, and the create route enforces it server-side.
    email_verified: bool
    already_member: bool
    # The user's latest request status for this org, or null if none yet.
    request_status: str | None


class JoinRequestView(BaseModel):
    """A requester's own view of the request they just opened."""

    model_config = ConfigDict(extra="forbid")

    id: str
    org_id: str
    org_name: str
    status: str
    created_at: str


class PendingRequestView(BaseModel):
    """One pending request in the org-admin roster."""

    model_config = ConfigDict(extra="forbid")

    id: str
    user_id: str
    email: str
    created_at: str


class DecisionView(BaseModel):
    """The outcome of an approve/deny decision."""

    model_config = ConfigDict(extra="forbid")

    id: str
    status: str
    decided_at: str | None


class OrgDomainView(BaseModel):
    """One operator-managed domain -> org association."""

    model_config = ConfigDict(extra="forbid")

    id: str
    org_id: str
    domain: str
    created_at: str


class CreateDomainBody(BaseModel):
    """Associate one verified domain with an org (platform admin)."""

    model_config = ConfigDict(extra="forbid")

    domain: str = Field(min_length=3, max_length=253)


# -- Requester surface ------------------------------------------------------


def _acting_user_id(actor: RequestActor) -> str:
    """Return the signed-in user's id, refusing API-key actors."""
    if actor.api_key_org_id is not None:
        raise ApiError(_KEY_ACTOR_MSG, status_code=403)
    return actor.user_id


@router.get("/join-requests/offer")
def get_join_offer(client: Client, actor: Actor) -> dict[str, JoinOfferView | None]:
    """Return the domain-match join offer for the signed-in user, or null.

    An offer exists only when the user's email domain maps to a real org. The
    offer carries the verification and membership state so the UI can render the
    right control (request, disabled-until-verified, pending, or already in).
    """
    user_id = _acting_user_id(actor)
    store = OrgJoinStore(client)
    offer = _resolve_offer(client, store, user_id)
    return {"offer": offer}


@router.post("/join-requests", status_code=201)
def create_join_request(client: Client, actor: Actor) -> JoinRequestView:
    """Open a pending request to join the user's domain-matched org.

    Gated end to end: the domain must map to a real org, the requester's email
    must be verified, and they must not already belong to the org. The user's
    personal org is never touched.
    """
    user_id = _acting_user_id(actor)
    store = OrgJoinStore(client)
    verification = store.user_verification(user_id)
    if verification is None:
        raise ApiError(_NO_ACCOUNT_MSG, status_code=404)
    domain = email_domain(verification.email)
    match = store.find_domain(domain) if domain is not None else None
    if match is None:
        raise ApiError(_NO_DOMAIN_ORG_MSG, status_code=404)
    org = load_org_row(client, match.org_id)
    # A banned org may not grow. Same 404 as an unmatched domain, so this
    # public entry point does not disclose the tenant's ban to outsiders.
    if org.get("banned_at") is not None:
        raise ApiError(_NO_DOMAIN_ORG_MSG, status_code=404)
    if not verification.inbox_proven:
        raise ApiError(_UNVERIFIED_MSG, status_code=403, code="email_unverified")
    if store.is_member(match.org_id, user_id):
        raise ApiError(_ALREADY_MEMBER_MSG, status_code=409)
    try:
        request = store.create_request(
            org_id=match.org_id, user_id=user_id, email=verification.email
        )
    except DuplicatePendingRequestError as error:
        raise ApiError(_PENDING_EXISTS_MSG, status_code=409) from error
    return JoinRequestView(
        id=request.id,
        org_id=request.org_id,
        org_name=str(org["name"]),
        status=request.status,
        created_at=request.created_at,
    )


def _resolve_offer(
    client: SupabaseClient, store: OrgJoinStore, user_id: str
) -> JoinOfferView | None:
    """Compute the domain-match offer for a user, or None when none applies."""
    verification = store.user_verification(user_id)
    if verification is None:
        return None
    domain = email_domain(verification.email)
    if domain is None:
        return None
    match = store.find_domain(domain)
    if match is None:
        return None
    org = find_one_by_columns(client, "organizations", {"id": match.org_id})
    if org is None:
        return None
    # A banned org is simply never offered, the same silence as no match.
    if org.get("banned_at") is not None:
        return None
    latest = store.latest_request(match.org_id, user_id)
    return JoinOfferView(
        org_id=match.org_id,
        org_name=str(org["name"]),
        org_slug=str(org["slug"]),
        email_verified=verification.inbox_proven,
        already_member=store.is_member(match.org_id, user_id),
        request_status=latest.status if latest is not None else None,
    )


# -- Org-admin surface ------------------------------------------------------


def _org_not_found(org_id: str) -> str:
    """Uniform not-found message shared by the org-scoped routes."""
    return f"Organization not found: {org_id}"


def _already_decided(status: str) -> str:
    """Uniform 409 message for a request that is no longer pending."""
    return f"Join request already {status}."


@router.get("/orgs/{org_id}/join-requests")
def list_join_requests(
    org_id: str, client: Client, actor: Actor
) -> dict[str, list[PendingRequestView]]:
    """List the org's pending join requests (org admins only)."""
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    store = OrgJoinStore(client)
    return {
        "requests": [
            PendingRequestView(
                id=request.id,
                user_id=request.user_id,
                email=request.email,
                created_at=request.created_at,
            )
            for request in store.list_pending_requests(org_id)
        ]
    }


@router.post("/orgs/{org_id}/join-requests/{request_id}/approve")
def approve_join_request(
    org_id: str, request_id: str, client: Client, actor: Actor
) -> DecisionView:
    """Approve a pending request, granting the requester membership (admins)."""
    org, request = _require_pending(client, actor, org_id, request_id)
    # A banned org may not grow. The request stays pending: an operator unban
    # makes it decidable again, and deny keeps working while banned.
    if org.get("banned_at") is not None:
        raise ApiError(_ORG_BANNED_MSG, status_code=409)
    store = OrgJoinStore(client)
    decided = store.approve_request(request, decided_by=actor.user_id)
    # A concurrent DENY may have won between the pending read and the atomic
    # approve: the RPC then returns the unchanged denied row. Report that as a
    # 409 rather than a 200 that would tell the admin access was granted.
    if decided.status != "approved":
        raise ApiError(_already_decided(decided.status), status_code=409)
    return DecisionView(id=decided.id, status=decided.status, decided_at=decided.decided_at)


@router.post("/orgs/{org_id}/join-requests/{request_id}/deny")
def deny_join_request(org_id: str, request_id: str, client: Client, actor: Actor) -> DecisionView:
    """Deny a pending request; nothing else changes (admins only)."""
    _, request = _require_pending(client, actor, org_id, request_id)
    store = OrgJoinStore(client)
    decided = store.deny_request(request, decided_by=actor.user_id)
    # A concurrent APPROVE may have won between the pending read and this
    # update: _decide then returns the competing approved row. Report that as a
    # 409 rather than a 200 that would tell the admin the request was denied.
    if decided.status != "denied":
        raise ApiError(_already_decided(decided.status), status_code=409)
    return DecisionView(id=decided.id, status=decided.status, decided_at=decided.decided_at)


def _require_pending(
    client: SupabaseClient, actor: RequestActor, org_id: str, request_id: str
) -> tuple[JsonObject, JoinRequestRecord]:
    """Load the org row and a pending request in it, gating the caller as org admin.

    A foreign-org id or a missing request is the same 404 so the route is no
    cross-tenant oracle; a decided request is a 409. The org row rides along
    so approve can refuse a banned tenant without a second read.
    """
    org = load_org_row(client, org_id)
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=_org_not_found(org_id))
    store = OrgJoinStore(client)
    request = store.get_request(request_id)
    if request is None or request.org_id != org_id:
        raise ApiError(f"Join request not found: {request_id}", status_code=404)
    if request.status != "pending":
        raise ApiError(_already_decided(request.status), status_code=409)
    return org, request


# -- Platform-admin domain management ---------------------------------------


@router.get("/admin/orgs/{org_id}/domains")
def list_org_domains(org_id: str, client: Client, actor: Actor) -> dict[str, list[OrgDomainView]]:
    """List an org's verified-domain associations (platform admins only)."""
    require_platform_admin(actor)
    load_org_row(client, org_id)
    store = OrgJoinStore(client)
    return {
        "domains": [
            OrgDomainView(
                id=record.id,
                org_id=record.org_id,
                domain=record.domain,
                created_at=record.created_at,
            )
            for record in store.list_org_domains(org_id)
        ]
    }


@router.post("/admin/orgs/{org_id}/domains", status_code=201)
def create_org_domain(
    org_id: str, body: CreateDomainBody, client: Client, actor: Actor
) -> OrgDomainView:
    """Associate one verified domain with an org (platform admins only)."""
    require_platform_admin(actor)
    load_org_row(client, org_id)
    domain = _normalize_domain(body.domain)
    store = OrgJoinStore(client)
    try:
        record = store.add_org_domain(org_id=org_id, domain=domain, created_by=actor.user_id)
    except DuplicateOrgDomainError as error:
        raise ApiError(
            f"Domain already associated with an organization: {domain}", status_code=409
        ) from error
    return OrgDomainView(
        id=record.id, org_id=record.org_id, domain=record.domain, created_at=record.created_at
    )


@router.delete("/admin/orgs/{org_id}/domains/{domain_id}")
def delete_org_domain(org_id: str, domain_id: str, client: Client, actor: Actor) -> dict[str, bool]:
    """Remove one domain association (platform admins only)."""
    require_platform_admin(actor)
    load_org_row(client, org_id)
    store = OrgJoinStore(client)
    if not store.delete_org_domain(org_id=org_id, domain_id=domain_id):
        raise ApiError(f"Domain association not found: {domain_id}", status_code=404)
    return {"deleted": True}


def _normalize_domain(raw: str) -> str:
    """Lowercase and validate a bare domain (no '@', at least one dot).

    Raises:
        ApiError: 422 when the value is not a plain registrable domain.
    """
    domain = raw.strip().lower()
    if (
        "@" in domain
        or " " in domain
        or "." not in domain
        or domain.startswith(".")
        or domain.endswith(".")
    ):
        raise ApiError(_BAD_DOMAIN_MSG, status_code=422)
    return domain
