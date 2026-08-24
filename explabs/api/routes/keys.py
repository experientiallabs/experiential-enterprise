# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Customer-facing read of an organization's API keys.

The management read of the key surface, reached with the org's own ``xpl_`` key
via the ``_CUSTOMER_KEY_ROUTES`` allowlist in ``explabs/api/app.py`` ("an agent
must be able to do via API everything a human does"). It mirrors the web
settings list exactly: name, prefix, and lifecycle timestamps. The plaintext
secret is never stored and never returned — only the display ``key_prefix``
and the last-4 ``key_suffix`` captured at mint.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.routes import get_supabase
from explabs.api.tenancy import RequestActor, get_request_actor, resolve_acting_org
from explabs.db.repositories import SupabaseClient
from explabs.db.stores.api_key_store import ApiKeyRecord, ApiKeyStore

router = APIRouter(prefix="/api", tags=["api keys"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]


class ApiKeyView(BaseModel):
    """Customer-safe projection of one ``api_keys`` row (never the secret/hash)."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    key_prefix: str
    # Last 4 chars of the plaintext, stored at mint for display recognition;
    # None on keys minted before the column existed.
    key_suffix: str | None
    created_at: str
    last_used_at: str | None
    revoked_at: str | None
    expires_at: str | None

    @classmethod
    def of(cls, record: ApiKeyRecord) -> ApiKeyView:
        """Project a store record onto the public shape (drops ``org_id``)."""
        return cls(
            id=record.id,
            name=record.name,
            key_prefix=record.key_prefix,
            key_suffix=record.key_suffix,
            created_at=record.created_at,
            last_used_at=record.last_used_at,
            revoked_at=record.revoked_at,
            expires_at=record.expires_at,
        )


@router.get("/keys", response_model=list[ApiKeyView])
def list_api_keys(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    include_revoked: bool = False,
) -> list[ApiKeyView]:
    """List the acting org's API keys (name, prefix/suffix, timestamps — never secrets).

    The org is resolved from the credential itself (an ``xpl_`` key names exactly
    its org; a session actor resolves to their sole membership), so this read
    carries no org id in the path. Revoked keys are excluded unless
    ``include_revoked`` is set, matching the web settings list.
    """
    org_id = resolve_acting_org(client, actor)
    store = ApiKeyStore(client)
    return [
        ApiKeyView.of(record)
        for record in store.list_for_org(org_id, include_revoked=include_revoked)
    ]
