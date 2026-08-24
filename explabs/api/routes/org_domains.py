# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Verified org domains: the DNS-TXT substrate SSO enforcement hangs off (E2).

CRUD under ``/api/orgs/{org_id}/domains``, admin-gated and behind the SSO
enterprise capability (absent — a plain 404 — when unlicensed). POST claims a
domain and returns the exact TXT record to publish
(``_explabs-verify.<domain>`` = the server-generated token); the verify route
performs a REAL DNS TXT lookup and stamps ``verified_at`` on a match. Only a
verified domain may toggle ``sso_required``, and only while the org has an
ENABLED SSO provider — the gate must never lock a tenant out with no IdP to
step up through. A verified domain maps to exactly one org deployment-wide
(the partial unique index is the authority; this API pre-checks for the
friendly 409).
"""

from __future__ import annotations

import re
import secrets as secrets_module
from datetime import UTC, datetime
from typing import Annotated

import dns.resolver
from dns.exception import DNSException, Timeout
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.capabilities import EnterpriseCapability, require_capability
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    SupabaseClient,
    find_one_by_columns,
)

router = APIRouter(prefix="/api", tags=["org-domains"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

# Mirrors the org_domains.domain CHECK so a bad domain fails here as a typed
# 400 instead of an opaque constraint violation.
_DOMAIN_MAX_LENGTH = 253
_DOMAIN_LABEL = r"[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?"
_TXT_RECORD_PREFIX = "_explabs-verify"
# Bounded DNS wait: a verify click must answer, not hang a worker thread.
_DNS_LIFETIME_SECONDS = 5.0


class OrgDomainView(BaseModel):
    """One claimed domain, with the TXT record the operator must publish."""

    model_config = ConfigDict(frozen=True)

    domain: str
    verified_at: str | None
    sso_required: bool
    # The exact DNS record verification looks for. The token is shown only on
    # this admin-gated surface and proves nothing but domain control.
    txt_record_name: str
    txt_record_value: str
    created_at: str | None


class OrgDomainsResponse(BaseModel):
    """The org's claimed domains, verified and pending alike."""

    org_id: str
    domains: list[OrgDomainView]


class DomainCreateRequest(BaseModel):
    """One domain claim."""

    model_config = ConfigDict(extra="forbid")

    domain: str = Field(min_length=1, max_length=_DOMAIN_MAX_LENGTH + 1)


class DomainSsoRequiredRequest(BaseModel):
    """The sso_required toggle for one verified domain."""

    model_config = ConfigDict(extra="forbid")

    sso_required: bool


class DomainDeleteResponse(BaseModel):
    """Whether the DELETE removed a row."""

    model_config = ConfigDict(frozen=True)

    deleted: bool


def _require_domains_admin(client: SupabaseClient, actor: RequestActor, org_id: str) -> None:
    """The shared gate: org exists, actor is org admin, org holds the SSO capability."""
    load_org_row(client, org_id)
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.ADMIN,
        not_found=f"Organization not found: {org_id}",
    )
    require_capability(client, org_id, EnterpriseCapability.SSO)


def _normalized_domain(raw: str) -> str:
    """Lowercase, trim, and shape-check one domain, or a 400 naming the problem."""
    domain = raw.strip().lower().rstrip(".")
    pattern = rf"^{_DOMAIN_LABEL}(\.{_DOMAIN_LABEL})+$"
    if len(domain) > _DOMAIN_MAX_LENGTH or re.fullmatch(pattern, domain) is None:
        msg = (
            f"Invalid domain: {raw!r}. Expected a bare DNS name like example.com "
            "(lowercase labels, no scheme, no path)."
        )
        raise ApiError(msg, status_code=400)
    return domain


def _domain_view(row: JsonObject) -> OrgDomainView:
    """Project one org_domains row onto the wire shape."""
    domain = str(row["domain"])
    verified_at = row.get("verified_at")
    created_at = row.get("created_at")
    return OrgDomainView(
        domain=domain,
        verified_at=str(verified_at) if verified_at is not None else None,
        sso_required=bool(row.get("sso_required", False)),
        txt_record_name=f"{_TXT_RECORD_PREFIX}.{domain}",
        txt_record_value=str(row["verification_token"]),
        created_at=str(created_at) if created_at is not None else None,
    )


def _find_domain_row(client: SupabaseClient, org_id: str, domain: str) -> JsonObject:
    """Fetch one claimed domain or fail with the resource 404."""
    row = find_one_by_columns(client, "org_domains", {"org_id": org_id, "domain": domain})
    if row is None:
        msg = f"Domain not found: {domain}"
        raise ApiError(msg, status_code=404)
    return row


def _lookup_txt_values(name: str) -> list[str]:
    """Resolve one name's TXT values over real DNS (the verify seam).

    Args:
        name: Fully qualified record name (``_explabs-verify.<domain>``).

    Returns:
        Every TXT string published at the name; empty when the name does not
        exist or holds no TXT records (an honest "not published yet").

    Raises:
        ApiError: 502 when resolution itself failed (timeout, no reachable
            nameserver) — distinct from "record absent", which the caller
            reports as a verification miss.
    """
    try:
        answer = dns.resolver.resolve(name, "TXT", lifetime=_DNS_LIFETIME_SECONDS)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        return []
    except (Timeout, dns.resolver.NoNameservers, DNSException) as error:
        msg = f"DNS lookup for {name} failed ({type(error).__name__}); try again shortly."
        raise ApiError(msg, status_code=502) from error
    values: list[str] = []
    for rdata in answer:
        # A TXT rdata is a tuple of byte strings; a long value is split into
        # 255-byte chunks that concatenate back into one logical value.
        chunks = getattr(rdata, "strings", ())
        values.append(b"".join(chunks).decode("utf-8", errors="replace"))
    return values


@router.get("/orgs/{org_id}/domains", response_model=OrgDomainsResponse)
def list_org_domains(org_id: str, client: Client, actor: Actor) -> OrgDomainsResponse:
    """List the org's claimed domains with their verification state."""
    _require_domains_admin(client, actor, org_id)
    result = client.table("org_domains").select("*").eq("org_id", org_id).execute()
    rows = sorted(result.data, key=lambda row: str(row.get("created_at", "")))
    return OrgDomainsResponse(org_id=org_id, domains=[_domain_view(row) for row in rows])


@router.post("/orgs/{org_id}/domains", response_model=OrgDomainView)
def create_org_domain(
    org_id: str,
    body: DomainCreateRequest,
    client: Client,
    actor: Actor,
) -> OrgDomainView:
    """Claim a domain and return the TXT record that proves control of it.

    The response IS the operator instruction: publish a TXT record named
    ``txt_record_name`` with ``txt_record_value`` as its value, then call
    the verify route. The token is server-generated; nothing client-supplied
    is ever accepted as a challenge.
    """
    _require_domains_admin(client, actor, org_id)
    domain = _normalized_domain(body.domain)
    # The table carries a GLOBAL unique(domain) (one claim per domain,
    # deployment-wide — 20260822180000). Refuse a taken domain with a neutral
    # message that never names the holding org; a disputed squat is a
    # platform-operator resolution, not information for the second claimant.
    taken = find_one_by_columns(client, "org_domains", {"domain": domain})
    if taken is not None:
        if str(taken.get("org_id", "")) == org_id:
            msg = f"Domain already claimed by this organization: {domain}"
        else:
            msg = f"Domain already claimed: {domain}"
        raise ApiError(msg, status_code=409)
    row: JsonObject = {
        "org_id": org_id,
        "domain": domain,
        "verification_token": secrets_module.token_urlsafe(32),
        "sso_required": False,
        "created_by": actor.user_id,
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    client.table("org_domains").insert(dict(row)).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ORG_DOMAINS_CREATE,
        object_type="org_domain",
        object_id=domain,
        after={"domain": domain},
    )
    return _domain_view(row)


@router.post("/orgs/{org_id}/domains/{domain}/verify", response_model=OrgDomainView)
def verify_org_domain(
    org_id: str,
    domain: str,
    client: Client,
    actor: Actor,
) -> OrgDomainView:
    """Perform the real DNS TXT lookup and stamp ``verified_at`` on a match.

    Idempotent once verified. A published-elsewhere conflict — the same
    domain already verified by another org — answers 409 here; the partial
    unique index remains the authority against the race.
    """
    _require_domains_admin(client, actor, org_id)
    domain = _normalized_domain(domain)
    row = _find_domain_row(client, org_id, domain)
    if row.get("verified_at") is not None:
        return _domain_view(row)
    claims = (
        client.table("org_domains").select("org_id, verified_at").eq("domain", domain).execute()
    )
    if any(
        other.get("verified_at") is not None and str(other.get("org_id")) != str(org_id)
        for other in claims.data
    ):
        msg = f"Domain {domain} is already verified by another organization."
        raise ApiError(msg, status_code=409)
    record_name = f"{_TXT_RECORD_PREFIX}.{domain}"
    token = str(row["verification_token"])
    if token not in _lookup_txt_values(record_name):
        msg = (
            f"No matching TXT record found at {record_name}. Publish a TXT "
            "record with the claim's verification token as its value, allow "
            "DNS propagation, then verify again."
        )
        raise ApiError(msg, status_code=409, code="txt_record_not_found")
    verified_at = datetime.now(tz=UTC).isoformat()
    client.table("org_domains").update({"verified_at": verified_at}).eq("org_id", org_id).eq(
        "domain", domain
    ).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ORG_DOMAINS_VERIFY,
        object_type="org_domain",
        object_id=domain,
        after={"domain": domain, "verified_at": verified_at},
    )
    updated = dict(row)
    updated["verified_at"] = verified_at
    return _domain_view(updated)


@router.patch("/orgs/{org_id}/domains/{domain}", response_model=OrgDomainView)
def set_org_domain_sso_required(
    org_id: str,
    domain: str,
    body: DomainSsoRequiredRequest,
    client: Client,
    actor: Actor,
) -> OrgDomainView:
    """Toggle ``sso_required`` on one VERIFIED domain.

    Turning it on requires an ENABLED SSO provider row: enforcing SSO with no
    IdP configured would lock every member out at step-up, so that state is
    refused loudly here (and again inside the provider RPCs on the
    disable/delete side).
    """
    _require_domains_admin(client, actor, org_id)
    domain = _normalized_domain(domain)
    row = _find_domain_row(client, org_id, domain)
    if row.get("verified_at") is None:
        msg = f"Domain {domain} is not verified; verify it before requiring SSO."
        raise ApiError(msg, status_code=409)
    if body.sso_required:
        provider = find_one_by_columns(client, "sso_providers", {"org_id": org_id, "enabled": True})
        if provider is None:
            msg = (
                "Requiring SSO needs an enabled SSO provider first — otherwise "
                "no session could ever satisfy the requirement."
            )
            raise ApiError(msg, status_code=409, code="sso_provider_required")
    before_flag = bool(row.get("sso_required", False))
    client.table("org_domains").update({"sso_required": body.sso_required}).eq("org_id", org_id).eq(
        "domain", domain
    ).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.SSO_REQUIRED_SET,
        object_type="org_domain",
        object_id=domain,
        before={"sso_required": before_flag},
        after={"sso_required": body.sso_required},
    )
    updated = dict(row)
    updated["sso_required"] = body.sso_required
    return _domain_view(updated)


@router.delete("/orgs/{org_id}/domains/{domain}", response_model=DomainDeleteResponse)
def delete_org_domain(
    org_id: str,
    domain: str,
    client: Client,
    actor: Actor,
) -> DomainDeleteResponse:
    """Remove one claimed domain (and, with it, any SSO requirement it carried)."""
    _require_domains_admin(client, actor, org_id)
    domain = _normalized_domain(domain)
    row = _find_domain_row(client, org_id, domain)
    query = client.table("org_domains")
    if not isinstance(query, DeleteCapableQuery):  # pragma: no cover - real clients delete
        msg = "Supabase query builder does not support delete"
        raise ApiError(msg, status_code=500)
    query.delete().eq("org_id", org_id).eq("domain", domain).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ORG_DOMAINS_DELETE,
        object_type="org_domain",
        object_id=domain,
        before={
            "domain": domain,
            "verified": row.get("verified_at") is not None,
            "sso_required": bool(row.get("sso_required", False)),
        },
    )
    return DomainDeleteResponse(deleted=True)
