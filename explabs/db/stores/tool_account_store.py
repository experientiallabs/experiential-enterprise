# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Org tool-account balances: typed access to ``tool_accounts``.

A tool account is a spend-visibility-only vendor account (E2B, Greptile,
Cursor, Devin) an org tracks a remaining-credit balance for on ``/credits``.
These are NOT model providers: they never route through the gateway and never
enter the catalog. Greptile/Cursor/Devin are gated to YC companies by the API
route (this store is vendor-agnostic).

The Vault shape mirrors ``provider_connection_store``: the optional
dashboard-login credential enters through ``set_tool_account_credential`` and
leaves only through ``release_tool_account_credential`` at fetch time, both
service-role RPCs, so this store never sees or returns credential material
outside those two seams. Unlike provider connections, a row can exist with no
credential at all (a purely self-declared balance, or E2B which is read with the
platform's ambient key).
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from explabs.db.repositories import (
    JsonObject,
    SupabaseClient,
    first_row,
    result_rows,
)


class TrackedToolVendor(StrEnum):
    """The tool vendors an org can track a credit balance for on /credits."""

    E2B = "e2b"
    GREPTILE = "greptile"
    CURSOR = "cursor"
    DEVIN = "devin"


# The vendors visible only to YC companies; E2B is visible to every org. The
# API route enforces this against the ``yc`` org label — the store stays agnostic.
YC_GATED_TOOL_VENDORS: frozenset[TrackedToolVendor] = frozenset(
    {TrackedToolVendor.GREPTILE, TrackedToolVendor.CURSOR, TrackedToolVendor.DEVIN}
)


class BalanceSource(StrEnum):
    """How the tracked balance figure was produced."""

    SELF_REPORTED = "self_reported"
    VENDOR_API = "vendor_api"
    COMPUTER_USE = "computer_use"


class FetchStatus(StrEnum):
    """The persisted outcome of the last balance-fetch attempt."""

    REPORTED = "reported"
    NOT_REPORTABLE = "not_reportable"
    READ_FAILED = "read_failed"
    # The computer-use agent path is wired but not yet enabled for this vendor.
    PENDING = "pending"


# Columns every tool-account read returns; no credential material is included.
_TOOL_ACCOUNT_COLUMNS = (
    "id, org_id, vendor, config, credential_last4, declared_balance_usd, "
    "declared_balance_set_at, balance_source, low_balance_threshold_usd, "
    "last_fetch_at, last_fetch_status, last_fetch_message"
)


def _dollars(value: object) -> float | None:
    """Postgres numeric may arrive as a decimal string; normalize to float."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return float(value)
    msg = f"expected a numeric balance value, got {type(value).__name__}"
    raise TypeError(msg)


class ToolAccountRecord(BaseModel):
    """Typed snapshot of a ``tool_accounts`` row (no credential material)."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    vendor: TrackedToolVendor
    config: JsonObject = Field(default_factory=dict)
    credential_last4: str | None = None
    declared_balance_usd: float | None = None
    declared_balance_set_at: str | None = None
    balance_source: BalanceSource | None = None
    low_balance_threshold_usd: float = 5.0
    last_fetch_at: str | None = None
    last_fetch_status: FetchStatus | None = None
    last_fetch_message: str | None = None

    @classmethod
    def of(cls, row: JsonObject) -> ToolAccountRecord:
        """Validate a raw row, coercing decimal-string numerics to floats."""
        threshold = _dollars(row.get("low_balance_threshold_usd"))
        return cls.model_validate(
            {
                **row,
                "config": row.get("config") or {},
                "declared_balance_usd": _dollars(row.get("declared_balance_usd")),
                "low_balance_threshold_usd": 5.0 if threshold is None else threshold,
            }
        )


class ToolAccountStore:
    """Persist and release org tool-account balances (Vault-backed credential)."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client (service role for writes and release).
        """
        self._client = client

    def list_for_org(self, org_id: str) -> list[ToolAccountRecord]:
        """Every tool account the org has a row for (connected or balance-only)."""
        result = (
            self._client.table("tool_accounts")
            .select(_TOOL_ACCOUNT_COLUMNS)
            .eq("org_id", org_id)
            .execute()
        )
        return [ToolAccountRecord.of(row) for row in result_rows(result)]

    def list_all(self) -> list[ToolAccountRecord]:
        """Every tool account across all orgs, for the scheduled balance fetch."""
        result = self._client.table("tool_accounts").select(_TOOL_ACCOUNT_COLUMNS).execute()
        return [ToolAccountRecord.of(row) for row in result_rows(result)]

    def find(self, org_id: str, vendor: TrackedToolVendor) -> ToolAccountRecord | None:
        """The org's account for one vendor, when a row exists."""
        result = (
            self._client.table("tool_accounts")
            .select(_TOOL_ACCOUNT_COLUMNS)
            .eq("org_id", org_id)
            .eq("vendor", vendor.value)
            .execute()
        )
        rows = result_rows(result)
        return ToolAccountRecord.of(rows[0]) if rows else None

    def ensure(
        self, *, org_id: str, vendor: TrackedToolVendor, actor: str | None = None
    ) -> ToolAccountRecord:
        """Return the org/vendor row, creating an empty one if it does not exist.

        Lets a balance be declared (or a fetch run) before any credential is
        stored. The insert is an idempotent upsert on the ``(org_id, vendor)``
        unique key: two first-time operations racing on the same account both
        resolve to the one winning row instead of one failing on the unique
        constraint. The service role bypasses RLS, so the write is safe.
        """
        self._client.table("tool_accounts").upsert(
            {
                "org_id": org_id,
                "vendor": vendor.value,
                "created_by": actor,
                "updated_by": actor,
            },
            on_conflict="org_id,vendor",
            ignore_duplicates=True,
        ).execute()
        created = self.find(org_id, vendor)
        if created is None:  # pragma: no cover - the upsert either wrote or raised
            msg = f"tool account not found after upsert: {org_id} {vendor.value}"
            raise ValueError(msg)
        return created

    def set_declared_balance(
        self,
        *,
        org_id: str,
        vendor: TrackedToolVendor,
        balance_usd: float | None,
        low_balance_threshold_usd: float | None = None,
        actor: str | None = None,
    ) -> ToolAccountRecord:
        """Set the self-declared remaining balance (null turns tracking off)."""
        self.ensure(org_id=org_id, vendor=vendor, actor=actor)
        changes: JsonObject = {
            "declared_balance_usd": balance_usd,
            "declared_balance_set_at": None
            if balance_usd is None
            else datetime.now(tz=UTC).isoformat(),
            "balance_source": None if balance_usd is None else BalanceSource.SELF_REPORTED.value,
            "updated_by": actor,
            "updated_at": datetime.now(tz=UTC).isoformat(),
        }
        if low_balance_threshold_usd is not None:
            changes["low_balance_threshold_usd"] = low_balance_threshold_usd
        return self._update(org_id, vendor, changes)

    def record_fetch(
        self,
        *,
        org_id: str,
        vendor: TrackedToolVendor,
        status: FetchStatus,
        message: str,
        balance_usd: float | None = None,
        source: BalanceSource | None = None,
    ) -> ToolAccountRecord:
        """Persist a balance-fetch outcome onto the row.

        A ``REPORTED`` outcome overwrites the tracked balance with the fetched
        figure; every outcome records the attempt's status and message so the
        UI can explain a not-reportable or pending fetch.
        """
        changes: JsonObject = {
            "last_fetch_at": datetime.now(tz=UTC).isoformat(),
            "last_fetch_status": status.value,
            "last_fetch_message": message,
            "updated_at": datetime.now(tz=UTC).isoformat(),
        }
        if status is FetchStatus.REPORTED and balance_usd is not None and source is not None:
            changes["declared_balance_usd"] = balance_usd
            changes["declared_balance_set_at"] = datetime.now(tz=UTC).isoformat()
            changes["balance_source"] = source.value
        return self._update(org_id, vendor, changes)

    def _update(
        self, org_id: str, vendor: TrackedToolVendor, changes: JsonObject
    ) -> ToolAccountRecord:
        """Apply a partial update to the org/vendor row and return it."""
        result = (
            self._client.table("tool_accounts")
            .update(changes)
            .eq("org_id", org_id)
            .eq("vendor", vendor.value)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            msg = f"tool account not found: {org_id} {vendor.value}"
            raise ValueError(msg)
        return ToolAccountRecord.of(rows[0])

    def set_credential(
        self,
        *,
        org_id: str,
        vendor: TrackedToolVendor,
        credential: str,
        actor: str | None = None,
    ) -> str:
        """Store or rotate the account's dashboard credential (goes to Vault).

        Returns:
            The stored credential's last four characters (the only readable
            trace).
        """
        result = self._client.rpc(
            "set_tool_account_credential",
            {
                "in_org_id": org_id,
                "in_vendor": vendor.value,
                "in_config": {},
                "in_secret": credential,
                "in_actor": actor,
            },
        ).execute()
        row = first_row(
            result, context=f"set_tool_account_credential for org {org_id} {vendor.value}"
        )
        last4 = row.get("credential_last4")
        if isinstance(last4, str) and last4:
            return last4
        msg = f"tool account credential write returned no last4 for org {org_id} {vendor.value}"
        raise ValueError(msg)

    def release_credential(self, account_id: str) -> str:
        """Decrypt one tool account's dashboard credential for a balance fetch."""
        result = self._client.rpc(
            "release_tool_account_credential",
            {"in_account_id": account_id},
        ).execute()
        row = first_row(result, context=f"release credential for tool account {account_id}")
        credential = row.get("credential")
        if isinstance(credential, str) and credential:
            return credential
        msg = f"tool account credential release returned no value: {account_id}"
        raise ValueError(msg)

    def delete(self, org_id: str, vendor: TrackedToolVendor) -> bool:
        """Disconnect one tool account (drops the row and any Vault secret)."""
        result = self._client.rpc(
            "delete_tool_account",
            {"in_org_id": org_id, "in_vendor": vendor.value},
        ).execute()
        rows = result_rows(result)
        if not rows:
            return False
        value = rows[0]
        if isinstance(value, dict):
            return bool(next(iter(value.values()), False))
        return bool(value)
