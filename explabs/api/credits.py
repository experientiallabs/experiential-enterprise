# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Organization credits: prepaid balance accounting and pre-spend enforcement.

Every organization holds prepaid credits recorded in the append-only
``credit_ledger`` (a $20 welcome grant on signup; top-ups and admin grants
after that). Two trigger-maintained counters on the organizations row make
the gate a one-row read, never a ledger or spend-table scan:

- ``credit_granted_usd``: the ledger sum.
- ``billable_spend_usd``: priced spend that draws down credits. This is
  ``spend_usd`` minus BYOK serving traffic — calls served on the org's own
  provider key are metered (they appear in every usage view) but the org
  already pays its provider for them, so they never consume platform credits.

Balance = ``credit_granted_usd - billable_spend_usd``. Enforcement lives in
Postgres, not here: the serving reservation gate refuses with
``P1002/credits_exhausted`` once the balance is used up (see migration
``20260818223646_optimizer_project_router_serving.sql``). The check is
pre-spend, so a request admitted with a positive balance may still push the
org past zero — an org can overdraw by at most one request's cost, and the
negative balance is carried honestly, not clamped. Both counters mirror the
priced-spend-only fold rules: unpriced traffic (no verified list price)
never draws down credits, matching the platform-wide null-over-guess
contract.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime

from explabs.api.routes import ApiError
from explabs.db.repositories import JsonObject, SupabaseClient, find_one_by_columns, result_rows
from explabs.db.stores.yc_claim_store import YC_GRANT_USD


def load_organization(client: SupabaseClient, org_id: str) -> JsonObject:
    """Read one organizations row, or 404.

    The row carries every trigger-maintained counter plus the org's own
    settings, so a caller that needs more than the credit view (the budget
    poll also reads the training cap) takes the ROW and projects it, rather
    than reading the same row twice.

    Args:
        client: Supabase client.
        org_id: Organization identifier.

    Returns:
        The raw organizations row.

    Raises:
        ApiError: 404 when the organization does not exist.
    """
    org = find_one_by_columns(client, "organizations", {"id": org_id})
    if org is None:
        msg = f"Organization not found: {org_id}"
        raise ApiError(msg, status_code=404)
    return org


def organization_credit(client: SupabaseClient, org_id: str) -> JsonObject:
    """Return one organization's trigger-maintained credit counters.

    This is the lightweight read for frequently refreshed UI surfaces. Unlike
    :func:`org_usage`, it never scans sessions, rollouts, or builds.

    Args:
        client: Supabase client.
        org_id: Organization identifier.

    Returns:
        The credit view fields (see :func:`organization_credit_view`).

    Raises:
        ApiError: 404 when the organization does not exist.
    """
    return organization_credit_view(load_organization(client, org_id))


def load_organization_with_yc(
    client: SupabaseClient, org_id: str
) -> tuple[JsonObject, JsonObject | None]:
    """Read one organizations row plus its YC claim state, or 404.

    Returns the raw organizations row and the member-facing ``yc`` block —
    ``None`` when the org has no launch grant or the grant already expired. The
    block reads the ``yc_launch`` grant in ``credit_ledger`` (source of truth
    since YC-company status moved to the ``yc`` label): a second targeted read,
    keyed on the grant's unique ``(source, source_ref)``.

    Args:
        client: Supabase client.
        org_id: Organization identifier.

    Returns:
        The raw organizations row and the ``yc`` view block (or ``None``).

    Raises:
        ApiError: 404 when the organization does not exist.
    """
    org = load_organization(client, org_id)
    grant = find_one_by_columns(
        client, "credit_ledger", {"source_ref": f"yc-launch:{org_id}", "entry_type": "grant"}
    )
    return org, organization_yc_view(org, grant)


def organization_yc_view(
    org: Mapping[str, object], grant: Mapping[str, object] | None
) -> JsonObject | None:
    """Project the member-facing YC block from an org row and its launch grant.

    ``remaining_estimate_usd`` is the display twin of the expiry clawback: the
    unspent remainder of the grant, from the billable counter delta since the
    grant and never above the live balance or below zero. An absent or
    already-expired grant reads as ``None`` — the block drives "unexpired YC
    grant" surfaces (the prominent balance card, the YC error copy), not
    history.

    Args:
        org: Raw organizations row (carries the trigger-maintained counters).
        grant: Raw ``yc_launch`` ``credit_ledger`` grant row, when present.

    Returns:
        ``{claimed_at, expires_at, remaining_estimate_usd}`` or ``None``.
    """
    if grant is None:
        return None
    claimed_at = grant.get("created_at")
    expires_at = grant.get("expires_at")
    # A launch grant with no expiry is not an "unexpired YC grant" surface.
    if not isinstance(claimed_at, str) or not isinstance(expires_at, str):
        return None
    if _parse_timestamp(expires_at) <= datetime.now(UTC):
        return None
    snapshot = grant.get("billable_spend_at_grant_usd")
    snapshot_usd = (
        float(snapshot)
        if isinstance(snapshot, int | float) and not isinstance(snapshot, bool)
        else 0.0
    )
    spent_since_grant = _billable_field(org) - snapshot_usd
    amount = grant.get("amount_usd")
    grant_amount = (
        float(amount)
        if isinstance(amount, int | float) and not isinstance(amount, bool)
        else YC_GRANT_USD
    )
    remaining = max(0.0, min(_balance(org), grant_amount - spent_since_grant))
    return {
        "claimed_at": claimed_at,
        "expires_at": expires_at,
        "remaining_estimate_usd": round(remaining, 6),
    }


def _parse_timestamp(value: str) -> datetime:
    """Parse one PostgREST timestamptz string into an aware datetime."""
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def platform_org_usage(client: SupabaseClient) -> list[JsonObject]:
    """Return every organization's credit counters.

    The admin panel's bulk read: all figures live on the organizations row
    (the counters are trigger-maintained), so the whole platform costs one
    paged select of one table, however many tenants exist.

    Args:
        client: Supabase client.

    Returns:
        One ``{org_id, spend_usd, billable_spend_usd, credit_granted_usd,
        credit_balance_usd, free_credit_caps_lifted_at,
        gateway_unknown_cost_attempts}`` entry per organization, in paged
        ``id`` order. The last two are the gateway billing-policy signals the
        Orgs panel renders: whether an admin lifted the free-credit daily
        caps, and how many platform-funded gateway attempts were billed $0
        because their cost was unknown (flagged for review).
    """
    page_size = 1000
    out: list[JsonObject] = []
    offset = 0
    while True:
        result = (
            client.table("organizations")
            .select(
                "id,spend_usd,billable_spend_usd,credit_granted_usd,"
                "free_credit_caps_lifted_at,gateway_unknown_cost_attempts"
            )
            .order("id")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        page = list(result_rows(result))
        out.extend(
            {
                "org_id": str(org["id"]),
                **organization_credit_view(org),
                "free_credit_caps_lifted_at": _timestamp_field(org, "free_credit_caps_lifted_at"),
                "gateway_unknown_cost_attempts": _count_field(org, "gateway_unknown_cost_attempts"),
            }
            for org in page
        )
        if len(page) < page_size:
            return out
        offset += page_size


def organization_credit_view(org: Mapping[str, object]) -> JsonObject:
    """Project the typed credit counters from an organizations row.

    Args:
        org: Raw organization row returned by Supabase.

    Returns:
        ``spend_usd`` (all metered usage), ``billable_spend_usd`` (the part
        that draws down credits), ``credit_granted_usd``, and the derived
        ``credit_balance_usd``.
    """
    granted = _granted_field(org)
    billable = _billable_field(org)
    return {
        "spend_usd": _numeric_field(org, "spend_usd"),
        "billable_spend_usd": billable,
        "credit_granted_usd": granted,
        "credit_balance_usd": granted - billable,
    }


def _balance(org: Mapping[str, object]) -> float:
    """The org's remaining credit in USD (may be negative after overdraw)."""
    return _granted_field(org) - _billable_field(org)


def _granted_field(org: Mapping[str, object]) -> float:
    return _numeric_field(org, "credit_granted_usd")


def _billable_field(org: Mapping[str, object]) -> float:
    return _numeric_field(org, "billable_spend_usd")


def _timestamp_field(org: Mapping[str, object], column: str) -> str | None:
    """Read a nullable timestamptz column as its ISO string (or ``None``)."""
    value = org.get(column)
    if value is not None and not isinstance(value, str):
        msg = f"organizations.{column} must be a timestamp string or null, got {value!r}"
        raise TypeError(msg)
    return value


def _count_field(org: Mapping[str, object], column: str) -> int:
    """Read a non-negative integer counter column, failing loudly on drift."""
    value = org.get(column)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        msg = f"organizations.{column} must be a non-negative integer, got {value!r}"
        raise TypeError(msg)
    return value


def _numeric_field(org: Mapping[str, object], column: str) -> float:
    """Read a counter column, failing loudly on drift.

    An ABSENT column raises rather than reading as zero: the columns are
    non-null with zero defaults, so absence means this build is running
    against an unmigrated database (or a stale PostgREST schema cache) — and
    a silent 0.0 would 402 every org while looking like a business decision.
    """
    if column not in org:
        msg = (
            f"organizations.{column} is missing from the row: the credit-ledger "
            "migration (20260729200000) has not been applied to this database "
            "(or the PostgREST schema cache is stale)"
        )
        raise RuntimeError(msg)
    value = org.get(column)
    if value is None or isinstance(value, bool) or not isinstance(value, int | float):
        msg = f"organizations.{column} must be numeric, got {value!r}"
        raise TypeError(msg)
    return float(value)
