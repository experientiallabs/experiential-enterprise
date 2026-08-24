# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Org-admin management of the per-org SCIM bearer token (design E3).

Three routes under ``/api/orgs/{org_id}/scim-token``: read the token's
status, mint (returns the plaintext bearer exactly once; only the last4 is
ever shown again), and revoke. Admin-gated and capability-gated: without the
SCIM enterprise capability the whole surface answers 404, absent not
forbidden.

Hash-only, the ``api_keys`` discipline: the plaintext is never stored
anywhere (no Vault copy), so minting again is the only rotation path and
immediately invalidates the previous bearer — one credential per org.
"""

from __future__ import annotations

import secrets
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.capabilities import EnterpriseCapability, require_capability
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    RepositoryError,
    SupabaseClient,
    find_one_by_columns,
)
from explabs.db.stores.api_key_store import hash_api_key
from explabs.db.stores.transitions import now_iso

router = APIRouter(prefix="/api", tags=["scim-admin"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

# Recognizable prefix, same idiom as the customer `xpl_` keys.
_TOKEN_PREFIX = "xplscim_"


class ScimTokenStatus(BaseModel):
    """What an org admin may see about the SCIM token after mint time."""

    model_config = ConfigDict(frozen=True)

    exists: bool
    last4: str | None = None
    created_at: str | None = None
    revoked_at: str | None = None
    key_policy: Literal["revoke", "keep"] | None = None


class ScimTokenMintRequest(BaseModel):
    """Mint-time configuration: the org's standing deprovision key policy."""

    model_config = ConfigDict(frozen=True)

    key_policy: Literal["revoke", "keep"] = "revoke"


class ScimTokenMintResponse(BaseModel):
    """The one and only response that ever carries the plaintext bearer."""

    model_config = ConfigDict(frozen=True)

    token: str
    last4: str
    created_at: str
    key_policy: Literal["revoke", "keep"]


def _require_scim_admin(client: SupabaseClient, actor: RequestActor, org_id: str) -> None:
    """Existence, admin-role, and capability gates shared by all three routes."""
    load_org_row(client, org_id)
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.ADMIN,
        not_found=f"Organization not found: {org_id}",
    )
    require_capability(client, org_id, EnterpriseCapability.SCIM)


def _status_view(row: JsonObject | None) -> ScimTokenStatus:
    """Project the org's token row (or its absence) onto the status shape."""
    if row is None:
        return ScimTokenStatus(exists=False)
    policy = str(row["deprovision_key_policy"])
    return ScimTokenStatus(
        exists=True,
        last4=str(row["token_last4"]),
        created_at=str(row["created_at"]),
        revoked_at=str(row["revoked_at"]) if row.get("revoked_at") is not None else None,
        key_policy="revoke" if policy == "revoke" else "keep",
    )


@router.get("/orgs/{org_id}/scim-token", response_model=ScimTokenStatus)
def get_scim_token_status(org_id: str, client: Client, actor: Actor) -> ScimTokenStatus:
    """Return the org's SCIM token status (last4 and lifecycle, never the hash)."""
    _require_scim_admin(client, actor, org_id)
    row = find_one_by_columns(client, "org_scim_tokens", {"org_id": org_id})
    return _status_view(row)


@router.post("/orgs/{org_id}/scim-token", response_model=ScimTokenMintResponse)
def mint_scim_token(
    org_id: str, body: ScimTokenMintRequest, client: Client, actor: Actor
) -> ScimTokenMintResponse:
    """Mint the org's SCIM bearer, replacing (and invalidating) any prior one.

    The plaintext rides this response exactly once; only its last4 is stored
    for display. Minting over a live token is the rotation path: the previous
    bearer stops authenticating the moment the row is replaced.
    """
    _require_scim_admin(client, actor, org_id)
    previous = find_one_by_columns(client, "org_scim_tokens", {"org_id": org_id})
    token = _TOKEN_PREFIX + secrets.token_urlsafe(32)
    created_at = now_iso()
    if previous is not None:
        replace_query = client.table("org_scim_tokens")
        if not isinstance(replace_query, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        replace_query.delete().eq("org_id", org_id).execute()
    client.table("org_scim_tokens").insert(
        {
            "org_id": org_id,
            "token_hash": hash_api_key(token),
            "token_last4": token[-4:],
            "deprovision_key_policy": body.key_policy,
            "created_by": actor.user_id,
            "created_at": created_at,
        }
    ).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.SCIM_TOKEN_MINT,
        object_type="scim_token",
        object_id=org_id,
        before={"last4": previous["token_last4"]} if previous is not None else None,
        after={"last4": token[-4:], "key_policy": body.key_policy},
    )
    return ScimTokenMintResponse(
        token=token,
        last4=token[-4:],
        created_at=created_at,
        key_policy=body.key_policy,
    )


@router.delete("/orgs/{org_id}/scim-token", response_model=ScimTokenStatus)
def revoke_scim_token(org_id: str, client: Client, actor: Actor) -> ScimTokenStatus:
    """Revoke the org's live SCIM bearer; SCIM requests stop authenticating."""
    _require_scim_admin(client, actor, org_id)
    row = find_one_by_columns(client, "org_scim_tokens", {"org_id": org_id})
    if row is None or row.get("revoked_at") is not None:
        msg = "No active SCIM token for this organization"
        raise ApiError(msg, status_code=404)
    revoked_at = now_iso()
    client.table("org_scim_tokens").update(
        {"revoked_at": revoked_at, "revoked_by": actor.user_id}
    ).eq("org_id", org_id).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.SCIM_TOKEN_REVOKE,
        object_type="scim_token",
        object_id=org_id,
        before={"last4": str(row["token_last4"])},
        after={"revoked_at": revoked_at},
    )
    updated = dict(row)
    updated["revoked_at"] = revoked_at
    return _status_view(updated)
