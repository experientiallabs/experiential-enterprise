# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Auth-side reads of ``public.platform_admin_keys`` (superadmin bearers).

The control API's middleware resolves a presented ``xpladmin_`` secret to its
owning operator here. READ-ONLY plus the last-used display touch by design:
minting and revocation live exclusively in the web app's platform-admin-gated
session routes, so a leaked superadmin key can never mint or revoke keys
through this layer.
"""

from __future__ import annotations

import datetime

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import SupabaseClient, result_rows
from explabs.db.stores.api_key_store import hash_api_key

# The superadmin bearer's recognizable prefix; the middleware branches on it
# before any lookup so customer keys and superadmin keys never share a code
# path or an error shape.
SUPERADMIN_KEY_PREFIX = "xpladmin_"


class PlatformAdminKeyRecord(BaseModel):
    """Typed snapshot of a live ``platform_admin_keys`` row (hash omitted)."""

    model_config = ConfigDict(frozen=True)

    id: str
    user_id: str
    name: str
    last_used_at: str | None = None


class PlatformAdminKeyStore:
    """Service-role reads over superadmin keys for request authentication."""

    def __init__(self, client: SupabaseClient) -> None:
        """Wrap a service-role Supabase client."""
        self._client = client

    def find_active_by_secret(self, secret: str) -> PlatformAdminKeyRecord | None:
        """Resolve a presented plaintext secret to its live key row.

        Args:
            secret: The ``xpladmin_`` bearer presented by the caller.

        Returns:
            The matching unrevoked key, or None. The caller must additionally
            verify the owner's ``platform_admins`` membership — a key is a
            credential, not an authority grant by itself.
        """
        result = (
            self._client.table("platform_admin_keys")
            .select("id, user_id, name, last_used_at, revoked_at")
            .eq("key_hash", hash_api_key(secret))
            .is_("revoked_at", "null")
            .limit(1)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        return PlatformAdminKeyRecord.model_validate(rows[0])

    def touch_last_used(self, key_id: str) -> None:
        """Stamp the key's ``last_used_at`` (display only, best-effort)."""
        self._client.table("platform_admin_keys").update(
            {"last_used_at": datetime.datetime.now(tz=datetime.UTC).isoformat()}
        ).eq("id", key_id).execute()
