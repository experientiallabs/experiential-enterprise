# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed access to ``public.app_settings``: the platform-wide singleton config.

``app_settings`` holds one row (its ``singleton`` boolean is both PK and the
enforced always-``true`` value). It carries the ``signups_enabled`` kill switch
plus the credit/spend-unlock knobs the admin Platform panel manages together:
the welcome and YC grant amounts, the pre-verify spend allowance, and the
spend-unlock requirement mode. Writes are service-role only (RLS is on with no
authenticated policy); this store is used by the admin backend, which holds the
service role.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import SupabaseClient, first_row

# The two states the pre-verify toggle flips between. ON lets an unverified
# founder spend up to $1 of granted credit before the P1025 spend gate blocks
# them; OFF requires email verification for all credits (block every unverified
# dollar).
PRE_VERIFY_ALLOWANCE_ON_MICRO_USD = 1_000_000  # $1
PRE_VERIFY_ALLOWANCE_OFF_MICRO_USD = 0

# What unlocks platform-credit spending for a locked org (app_settings flag from
# migration 20260827130000). The web spend-unlock layer routes on the same flag.
SpendUnlockRequirement = Literal["email", "card"]

_PRE_VERIFY_COLUMN = "pre_verify_allowance_micro_usd"
_WELCOME_GRANT_COLUMN = "welcome_grant_micro_usd"
_YC_GRANT_COLUMN = "yc_grant_micro_usd"
_SPEND_UNLOCK_COLUMN = "spend_unlock_requirement"
_ALL_COLUMNS = (
    _WELCOME_GRANT_COLUMN,
    _YC_GRANT_COLUMN,
    _PRE_VERIFY_COLUMN,
    _SPEND_UNLOCK_COLUMN,
)
# app_settings is a single-row table whose boolean PK is always true; writes
# filter on it. Named to keep the boolean literal out of the .eq() call.
_SINGLETON_PK = True


class CreditGateSettings(BaseModel):
    """The credit/spend-unlock knobs the admin Platform panel shows together."""

    model_config = ConfigDict(frozen=True)

    welcome_grant_micro_usd: int
    yc_grant_micro_usd: int
    pre_verify_allowance_micro_usd: int
    spend_unlock_requirement: SpendUnlockRequirement


class AppSettingsStore:
    """Reads and writes over the single ``app_settings`` row."""

    def __init__(self, client: SupabaseClient) -> None:
        """Wrap a service-role Supabase client (writes are service-role only)."""
        self._client = client

    def get_credit_gate_settings(self) -> CreditGateSettings:
        """Return every credit/spend-unlock knob in one read."""
        columns = ", ".join(_ALL_COLUMNS)
        result = self._client.table("app_settings").select(columns).limit(1).execute()
        row = first_row(result, context="app_settings credit/gate settings read")
        return CreditGateSettings(
            welcome_grant_micro_usd=_coerce_micro_usd(row.get(_WELCOME_GRANT_COLUMN)),
            yc_grant_micro_usd=_coerce_micro_usd(row.get(_YC_GRANT_COLUMN)),
            pre_verify_allowance_micro_usd=_coerce_micro_usd(row.get(_PRE_VERIFY_COLUMN)),
            spend_unlock_requirement=_coerce_spend_unlock(row.get(_SPEND_UNLOCK_COLUMN)),
        )

    def get_pre_verify_allowance_micro_usd(self) -> int:
        """Return the platform-wide pre-verify spend allowance in micro-USD.

        Returns:
            The stored allowance (``0`` = email verification required for all
            credits; ``1_000_000`` = $1 of pre-verification headroom).
        """
        result = self._client.table("app_settings").select(_PRE_VERIFY_COLUMN).limit(1).execute()
        row = first_row(result, context="app_settings pre-verify allowance read")
        return _coerce_micro_usd(row.get(_PRE_VERIFY_COLUMN))

    def set_pre_verify_allowance_micro_usd(self, micro_usd: int) -> int:
        """Set the platform-wide pre-verify spend allowance.

        Args:
            micro_usd: New allowance in micro-USD; must be a nonnegative int
                (the column's check constraint refuses negatives at the DB, but
                this fails loudly at the typed boundary first).

        Returns:
            The persisted allowance, read back from the updated row.
        """
        return self._set_micro_usd(_PRE_VERIFY_COLUMN, micro_usd)

    def set_welcome_grant_micro_usd(self, micro_usd: int) -> int:
        """Set the signup welcome grant (micro-USD); grant_signup_promo reads it."""
        return self._set_micro_usd(_WELCOME_GRANT_COLUMN, micro_usd)

    def set_yc_grant_micro_usd(self, micro_usd: int) -> int:
        """Set the YC launch grant (micro-USD); apply_yc_launch_grant reads it."""
        return self._set_micro_usd(_YC_GRANT_COLUMN, micro_usd)

    def set_spend_unlock_requirement(self, mode: str) -> SpendUnlockRequirement:
        """Set what unlocks spend for a locked org: ``'email'`` or ``'card'``."""
        coerced = _coerce_spend_unlock(mode)
        result = (
            self._client.table("app_settings")
            .update({_SPEND_UNLOCK_COLUMN: coerced})
            .eq("singleton", _SINGLETON_PK)
            .execute()
        )
        row = first_row(result, context="app_settings spend-unlock requirement write")
        return _coerce_spend_unlock(row.get(_SPEND_UNLOCK_COLUMN))

    def _set_micro_usd(self, column: str, micro_usd: int) -> int:
        """Write one nonnegative micro-USD column on the singleton row."""
        if isinstance(micro_usd, bool) or not isinstance(micro_usd, int) or micro_usd < 0:
            msg = f"{column} must be a nonnegative int, got {micro_usd!r}"
            raise ValueError(msg)
        result = (
            self._client.table("app_settings")
            .update({column: micro_usd})
            .eq("singleton", _SINGLETON_PK)
            .execute()
        )
        row = first_row(result, context=f"app_settings {column} write")
        return _coerce_micro_usd(row.get(column))


def _coerce_micro_usd(value: object) -> int:
    """Validate a bigint column arrives as a nonnegative int, not a sentinel."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        msg = f"micro-USD setting must be a nonnegative integer, got {value!r}"
        raise TypeError(msg)
    return value


def _coerce_spend_unlock(value: object) -> SpendUnlockRequirement:
    """Validate the spend-unlock mode is one of the enum values."""
    match value:
        case "email":
            return "email"
        case "card":
            return "card"
        case _:
            msg = f"spend_unlock_requirement must be 'email' or 'card', got {value!r}"
            raise ValueError(msg)
