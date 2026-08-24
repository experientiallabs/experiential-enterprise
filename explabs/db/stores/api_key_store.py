# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for customer API keys.

An ``api_keys`` row maps the SHA-256 hash of a customer-held secret to the
organization it serves. The backend resolves a presented secret to its org on
every request; the plaintext secret is never stored.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import (
    SupabaseClient,
    result_rows,
)
from explabs.db.stores.transitions import now_iso


def hash_api_key(secret: str) -> str:
    """Return the storage digest for an API-key secret."""
    return hashlib.sha256(secret.encode()).hexdigest()


class ApiKeyRecord(BaseModel):
    """Typed snapshot of an ``api_keys`` row (secret hash omitted)."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    name: str
    key_prefix: str
    # Last 4 chars of the plaintext, stored at mint for display recognition;
    # None on keys minted before the column existed.
    key_suffix: str | None
    created_at: str
    last_used_at: str | None
    revoked_at: str | None
    expires_at: str | None


class ApiKeyStore:
    """Reads and updates over ``api_keys`` rows."""

    def __init__(self, client: SupabaseClient) -> None:
        """Bind the store to a Supabase client."""
        self._client = client

    def find_active_by_secret(self, secret: str) -> ApiKeyRecord | None:
        """Resolve a presented plaintext secret to its live key row.

        Args:
            secret: The bearer credential presented by the caller.

        Returns:
            The matching unrevoked, unexpired key, or None.
        """
        result = (
            self._client.table("api_keys")
            .select(
                "id, org_id, name, key_prefix, key_suffix, created_at, last_used_at, revoked_at, expires_at"
            )
            .eq("key_hash", hash_api_key(secret))
            .is_("revoked_at", "null")
            .limit(1)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        record = ApiKeyRecord.model_validate(rows[0])
        # The unique hash keys the fetch to one row, so a SQL-side expiry
        # filter would save nothing and would compare against the same
        # client-supplied clock; check the single fetched row here instead.
        if _is_expired(record.expires_at):
            return None
        return record

    def list_for_org(self, org_id: str, *, include_revoked: bool = False) -> list[ApiKeyRecord]:
        """Return an org's API keys, newest first (secret hash always omitted).

        Args:
            org_id: The organization whose keys to list.
            include_revoked: When False (default), revoked keys are excluded,
                matching the web settings list; when True, every key is returned.

        Returns:
            The org's key rows as typed records, newest ``created_at`` first.
        """
        query = (
            self._client.table("api_keys")
            .select(
                "id, org_id, name, key_prefix, key_suffix, created_at, last_used_at, revoked_at, expires_at"
            )
            .eq("org_id", org_id)
        )
        if not include_revoked:
            query = query.is_("revoked_at", "null")
        result = query.order("created_at", desc=True).execute()
        return [ApiKeyRecord.model_validate(row) for row in result_rows(result)]

    def find_creator(self, key_id: str) -> str | None:
        """Return the user id that minted a key, or None for a creatorless key.

        Deliberately a narrow lookup rather than a ``created_by`` field on
        ``ApiKeyRecord``: the record is serialized to org members by the key
        list routes, and the creator's user id is server-internal. The one
        consumer is the YC claim resolving an api-key actor to the human who
        minted the key (explabs/api/routes/yc.py).

        Args:
            key_id: The ``api_keys`` row id (an authenticated actor's key).

        Returns:
            The ``created_by`` user id, or None when the key has no recorded
            creator (seeded or migration-era keys).
        """
        result = (
            self._client.table("api_keys").select("created_by").eq("id", key_id).limit(1).execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        creator = rows[0].get("created_by")
        return creator if isinstance(creator, str) else None

    def touch_last_used(self, key_id: str) -> None:
        """Best-effort bump of ``last_used_at`` for usage visibility."""
        self._client.table("api_keys").update({"last_used_at": now_iso()}).eq(
            "id", key_id
        ).execute()


def _is_expired(expires_at: str | None) -> bool:
    """Return whether an ISO expiry timestamp has passed (NULL never expires)."""
    if expires_at is None:
        return False
    return datetime.fromisoformat(expires_at) <= datetime.now(tz=UTC)
