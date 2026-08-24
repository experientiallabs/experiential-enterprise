# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Per-org SSO provider registration (E2, /ee): one SAML or OIDC IdP per org.

``PUT/GET/DELETE /api/orgs/{org_id}/sso-provider``, admin-gated and behind
the SSO enterprise capability. The row stores non-secret IdP metadata only;
an OIDC client secret goes straight to Vault through the
``upsert_sso_provider`` definer RPC and is never echoed. Enabling requires at
least one verified domain, and the provider cannot be disabled or deleted
while any domain still has ``sso_required`` set — both no-lockout invariants
are enforced here for the typed 409 and again inside the definer RPCs as the
authority.

What is deliberately NOT here: registering the IdP with GoTrue's admin SSO
API (the call that makes ``signInWithSSO`` actually reach the customer's
IdP). That lands with the first real IdP validation — see
``_sync_provider_to_gotrue``.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.capabilities import EnterpriseCapability, require_capability
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import JsonObject, SupabaseClient, find_one_by_columns, result_rows

router = APIRouter(prefix="/api", tags=["sso"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]


class SamlProviderMetadata(BaseModel):
    """Non-secret SAML IdP configuration."""

    model_config = ConfigDict(extra="forbid")

    # Where the IdP publishes its SAML metadata document.
    metadata_url: str = Field(min_length=1, pattern=r"^https://")
    # SAML assertion attribute -> platform field (e.g. email, name).
    attribute_mapping: dict[str, str] = Field(default_factory=dict)


class OidcProviderMetadata(BaseModel):
    """Non-secret OIDC IdP configuration (the client secret rides Vault)."""

    model_config = ConfigDict(extra="forbid")

    issuer: str = Field(min_length=1, pattern=r"^https://")
    client_id: str = Field(min_length=1)
    attribute_mapping: dict[str, str] = Field(default_factory=dict)


class SsoProviderUpsertRequest(BaseModel):
    """One PUT body: the whole desired provider state, idempotently."""

    model_config = ConfigDict(extra="forbid")

    provider_type: Literal["saml", "oidc"]
    metadata: JsonObject
    default_role: Literal["admin", "user"] = "user"
    enabled: bool = False
    # OIDC only; straight to Vault through the definer RPC, never stored on
    # the row and never echoed back.
    client_secret: str | None = None


class SsoProviderView(BaseModel):
    """The customer-safe projection of one provider (never any secret)."""

    model_config = ConfigDict(frozen=True)

    provider_type: str
    metadata: JsonObject
    default_role: str
    enabled: bool
    has_client_secret: bool


class SsoProviderDeleteResponse(BaseModel):
    """Whether the DELETE removed the provider."""

    model_config = ConfigDict(frozen=True)

    deleted: bool


def _require_sso_admin(client: SupabaseClient, actor: RequestActor, org_id: str) -> None:
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


def _validated_metadata(provider_type: str, metadata: JsonObject) -> JsonObject:
    """One metadata payload through its provider's typed shape, or a 400."""
    shape: type[BaseModel] = (
        SamlProviderMetadata if provider_type == "saml" else OidcProviderMetadata
    )
    try:
        validated = shape.model_validate(metadata)
    except ValidationError as error:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in issue['loc']) or 'metadata'}: {issue['msg']}"
            for issue in error.errors()
        )
        msg = f"Invalid {provider_type} metadata — {problems}."
        raise ApiError(msg, status_code=400) from error
    return validated.model_dump()


def _sync_provider_to_gotrue(org_id: str, provider_type: str, metadata: JsonObject) -> None:
    """SEAM — GoTrue IdP registration is deliberately not built yet.

    Making sign-in reach the customer's IdP requires registering it with
    GoTrue's admin SSO API (``POST /admin/sso/providers`` with the SAML
    metadata URL / OIDC client config) and keeping that registration in step
    with this row. Per the honesty rule that wiring lands with the FIRST REAL
    IdP validation (a design partner's Okta or Entra tenant), not before, so
    it cannot ship silently broken. Until then the platform stores and gates
    on the configuration; the sign-in button surfaces GoTrue's own "no such
    provider" error rather than a faked flow.

    Binding contract for the JIT half when this lands (build-scim, migration
    20260901160000_scim_and_ownership.sql): an IdP-initiated sign-in that
    CREATES the account must set user_metadata
    ``{"explabs_provisioned_via": "sso_jit"}`` at creation (the re-created
    ``provision_signup_org()`` early-returns on it — never re-create that
    function here) and insert one ``public.account_provenance`` row
    (user_id, provisioned_by_org_id = the verified domain's org,
    provisioned_via = 'sso_jit'). Exactly on creation, never when an
    existing account merely links an IdP later.

    Args:
        org_id: Organization whose provider changed.
        provider_type: ``saml`` or ``oidc``.
        metadata: The validated non-secret IdP configuration.
    """
    del org_id, provider_type, metadata


def _provider_view(row: JsonObject) -> SsoProviderView:
    """Project one sso_providers row (or RPC row) onto the wire shape."""
    metadata = row.get("metadata")
    has_secret = row.get("has_client_secret")
    if has_secret is None:
        has_secret = row.get("vault_secret_id") is not None
    return SsoProviderView(
        provider_type=str(row["provider_type"]),
        metadata={str(key): value for key, value in metadata.items()}
        if isinstance(metadata, dict)
        else {},
        default_role=str(row.get("default_role", "user")),
        enabled=bool(row.get("enabled", False)),
        has_client_secret=bool(has_secret),
    )


def _org_requires_sso(client: SupabaseClient, org_id: str) -> bool:
    """Whether any verified domain of the org currently has sso_required set."""
    result = (
        client.table("org_domains")
        .select("sso_required, verified_at")
        .eq("org_id", org_id)
        .eq("sso_required", True)  # noqa: FBT003 - supabase eq() is positional-only
        .execute()
    )
    return any(row.get("verified_at") is not None for row in result.data)


def _org_has_verified_domain(client: SupabaseClient, org_id: str) -> bool:
    """Whether the org holds at least one verified domain."""
    result = (
        client.table("org_domains").select("domain, verified_at").eq("org_id", org_id).execute()
    )
    return any(row.get("verified_at") is not None for row in result.data)


@router.get("/orgs/{org_id}/sso-provider", response_model=SsoProviderView)
def get_sso_provider(org_id: str, client: Client, actor: Actor) -> SsoProviderView:
    """Read the org's registered IdP (404 when none is configured)."""
    _require_sso_admin(client, actor, org_id)
    row = find_one_by_columns(client, "sso_providers", {"org_id": org_id})
    if row is None:
        msg = "No SSO provider is configured for this organization."
        raise ApiError(msg, status_code=404)
    return _provider_view(row)


@router.put("/orgs/{org_id}/sso-provider", response_model=SsoProviderView)
def put_sso_provider(
    org_id: str,
    body: SsoProviderUpsertRequest,
    client: Client,
    actor: Actor,
) -> SsoProviderView:
    """Create or update the org's IdP registration (one provider per org)."""
    _require_sso_admin(client, actor, org_id)
    if body.provider_type == "saml" and body.client_secret is not None:
        msg = "A SAML provider carries no client secret; secrets are OIDC-only."
        raise ApiError(msg, status_code=400)
    metadata = _validated_metadata(body.provider_type, body.metadata)
    if body.enabled and not _org_has_verified_domain(client, org_id):
        msg = "Enabling SSO requires at least one verified domain."
        raise ApiError(msg, status_code=409, code="verified_domain_required")
    if not body.enabled and _org_requires_sso(client, org_id):
        msg = (
            "A domain in this organization requires SSO; turn sso_required "
            "off before disabling the provider."
        )
        raise ApiError(msg, status_code=409, code="sso_required_active")
    result = client.rpc(
        "upsert_sso_provider",
        {
            "in_org_id": org_id,
            "in_provider_type": body.provider_type,
            "in_metadata": metadata,
            "in_default_role": body.default_role,
            "in_enabled": body.enabled,
            "in_secret": body.client_secret,
            "in_actor": actor.user_id,
        },
    ).execute()
    rows = result_rows(result)
    if not rows:  # pragma: no cover - the RPC either returns the row or raises
        msg = "SSO provider write returned no row."
        raise ApiError(msg, status_code=500)
    _sync_provider_to_gotrue(org_id, body.provider_type, metadata)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.SSO_PROVIDER_SET,
        object_type="sso_provider",
        object_id=body.provider_type,
        after={
            "provider_type": body.provider_type,
            "default_role": body.default_role,
            "enabled": body.enabled,
            "metadata": metadata,
        },
    )
    return _provider_view(rows[0])


@router.delete("/orgs/{org_id}/sso-provider", response_model=SsoProviderDeleteResponse)
def delete_sso_provider(org_id: str, client: Client, actor: Actor) -> SsoProviderDeleteResponse:
    """Remove the org's IdP registration (and its Vault-held secret, if any)."""
    _require_sso_admin(client, actor, org_id)
    if _org_requires_sso(client, org_id):
        msg = (
            "A domain in this organization requires SSO; turn sso_required "
            "off before deleting the provider."
        )
        raise ApiError(msg, status_code=409, code="sso_required_active")
    existing = find_one_by_columns(client, "sso_providers", {"org_id": org_id})
    if existing is None:
        msg = "No SSO provider is configured for this organization."
        raise ApiError(msg, status_code=404)
    client.rpc("delete_sso_provider", {"in_org_id": org_id}).execute()
    _sync_provider_to_gotrue(org_id, str(existing["provider_type"]), {})
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.SSO_PROVIDER_DELETE,
        object_type="sso_provider",
        object_id=str(existing["provider_type"]),
        before={
            "provider_type": str(existing["provider_type"]),
            "enabled": bool(existing.get("enabled", False)),
        },
    )
    return SsoProviderDeleteResponse(deleted=True)
