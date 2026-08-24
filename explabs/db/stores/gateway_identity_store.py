# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for the gateway identity tier: identities, grants, and budgets.

These are the management-plane tables the P-D API writes and reads. The runtime
hot path never reaches this store: it reads gateway_grants (deny-by-default
authorization, P-B) and gateway_budgets (reserve-time enforcement, P-C) directly
as postgres. This store is the control-plane mirror over the same rows, reached
by the dashboard as service_role.

Shapes mirror WMO's already-shipped contracts (IdentityRecord, GrantRecord,
MonthlyBudgetRecord) so a later switch to the full platform factory is a
drop-in.
"""

from __future__ import annotations

import re
import uuid

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import (
    DeleteCapableQuery,
    RepositoryError,
    SupabaseClient,
    is_unique_violation,
    result_rows,
)
from explabs.db.stores.transitions import now_iso

# The ArtifactId shape gateway_identities.identity_id is checked against
# (migration 20260820090000). Generated ids and any caller-supplied id must
# match it, and the per-org default identity's id ('org-' || org_id) does too.
_IDENTITY_ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*([._-][a-z0-9]+)*$")

# The monthly-budget scopes; the DB CHECK enforces the exact identifier set
# each one carries (team none; identity identity_id; key api_key_id; model
# alias_id; pool alias+pool; deployment alias+pool+deployment).
BUDGET_SCOPE_KINDS = ("team", "identity", "key", "model", "pool", "deployment")

# A budget's period is a pinned 'YYYY-MM' month or this sentinel, meaning the
# limit recurs every month (measured against each month's own spend).
RECURRING_PERIOD = "*"

_IDENTITY_COLUMNS = "identity_id, org_id, display_name, description, active, created_at, updated_at"
_BUDGET_COLUMNS = (
    "budget_id, org_id, period, scope_kind, api_key_id, identity_id, alias_id, "
    "pool_id, deployment_id, limit_micro_usd, created_at, updated_at"
)


def default_identity_id(org_id: str) -> str:
    """Return the org's default identity id, the control store's synthetic value.

    Args:
        org_id: Organization uuid.

    Returns:
        The ``org-{org_id}`` identity id every org owns from the P-A cutover.
    """
    return f"org-{org_id}"


def slugify_identity_id(display_name: str, org_id: str) -> str:
    """Derive a valid, unique-enough identity id from a display name.

    Lowercases, collapses runs of non-alphanumerics into single hyphens, and
    trims to the ArtifactId shape; a leading digit is prefixed so the id always
    starts with a letter. A short random suffix keeps two identities with the
    same display name distinct without a read-modify-write.

    Args:
        display_name: Human label the operator typed.
        org_id: Organization uuid, used only to seed the suffix entropy source.

    Returns:
        An id matching ``_IDENTITY_ID_PATTERN``.
    """
    lowered = display_name.strip().lower()
    collapsed = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")
    if not collapsed or not collapsed[0].isalpha():
        collapsed = f"id-{collapsed}" if collapsed else "id"
    # Trim to leave room for the suffix under the 128-char column bound.
    stem = collapsed[:96].rstrip("-") or "id"
    # The ``org-`` prefix is reserved for the per-org default identity; a display
    # name like "Org Team" must not slug into it (the explicit-id path rejects
    # such ids, so the derived path must honor the same invariant).
    if stem == "org" or stem.startswith("org-"):
        stem = f"id-{stem}"[:96].rstrip("-")
    suffix = uuid.uuid4().hex[:8]
    return f"{stem}-{suffix}"


def is_valid_identity_id(identity_id: str) -> bool:
    """Return whether an id matches the identity ArtifactId shape."""
    return bool(_IDENTITY_ID_PATTERN.fullmatch(identity_id))


class IdentityRecord(BaseModel):
    """Typed snapshot of a ``gateway_identities`` row."""

    model_config = ConfigDict(frozen=True)

    identity_id: str
    org_id: str
    display_name: str
    description: str | None
    active: bool
    created_at: str
    updated_at: str


class IdentitySummary(BaseModel):
    """An identity plus its derived counts for the management list view."""

    model_config = ConfigDict(frozen=True)

    identity: IdentityRecord
    active_key_count: int
    is_default: bool


class AliasSummary(BaseModel):
    """A grantable alias: one column of the identity x alias grant matrix."""

    model_config = ConfigDict(frozen=True)

    alias_id: str
    alias_name: str
    origin: str
    # True for the org's own custom alias, False for a public-catalog alias.
    org_scoped: bool


class GrantEdge(BaseModel):
    """One identity -> alias authorization (WMO GrantRecord, name projected)."""

    model_config = ConfigDict(frozen=True)

    identity_id: str
    alias_id: str


class BudgetRecord(BaseModel):
    """Typed snapshot of a ``gateway_budgets`` row (limit + scope only)."""

    model_config = ConfigDict(frozen=True)

    budget_id: str
    org_id: str
    period: str
    scope_kind: str
    api_key_id: str | None
    identity_id: str | None
    alias_id: str | None
    pool_id: str | None
    deployment_id: str | None
    limit_micro_usd: int


class BudgetBalance(BaseModel):
    """A budget's limit and derived spend for the meter (from the read seam)."""

    model_config = ConfigDict(frozen=True)

    budget_id: str
    period: str
    scope_kind: str
    api_key_id: str | None
    identity_id: str | None
    alias_id: str | None
    pool_id: str | None
    deployment_id: str | None
    limit_micro_usd: int
    reserved_micro_usd: int
    settled_micro_usd: int

    @property
    def remaining_micro_usd(self) -> int:
        """Limit minus reserved-and-settled spend, floored at zero."""
        return max(0, self.limit_micro_usd - self.reserved_micro_usd - self.settled_micro_usd)


class GatewayIdentityStore:
    """Reads and writes over the gateway identity-tier management tables."""

    def __init__(self, client: SupabaseClient) -> None:
        """Bind the store to a Supabase client (service_role in production)."""
        self._client = client

    # -- Identities ---------------------------------------------------------

    def list_identities(self, org_id: str) -> tuple[IdentitySummary, ...]:
        """List an org's identities, newest last, with active-key counts.

        Args:
            org_id: Owning organization uuid.

        Returns:
            One summary per identity, the default identity sorted first.
        """
        rows = result_rows(
            self._client.table("gateway_identities")
            .select(_IDENTITY_COLUMNS)
            .eq("org_id", org_id)
            .order("created_at", desc=False)
            .execute()
        )
        counts = self._active_key_counts(org_id)
        default_id = default_identity_id(org_id)
        summaries = [
            IdentitySummary(
                identity=IdentityRecord.model_validate(row),
                active_key_count=counts.get(str(row["identity_id"]), 0),
                is_default=str(row["identity_id"]) == default_id,
            )
            for row in rows
        ]
        # Default identity first, then the operator's own identities by age.
        summaries.sort(key=lambda summary: (not summary.is_default, summary.identity.created_at))
        return tuple(summaries)

    def get_identity(self, org_id: str, identity_id: str) -> IdentityRecord | None:
        """Return one identity scoped to its org, or None if absent."""
        rows = result_rows(
            self._client.table("gateway_identities")
            .select(_IDENTITY_COLUMNS)
            .eq("org_id", org_id)
            .eq("identity_id", identity_id)
            .limit(1)
            .execute()
        )
        return IdentityRecord.model_validate(rows[0]) if rows else None

    def create_identity(
        self,
        *,
        org_id: str,
        identity_id: str,
        display_name: str,
        description: str | None,
    ) -> IdentityRecord:
        """Insert one identity under an org and return the stored row.

        The generated columns (active, created_at, updated_at) are set here
        rather than left to their DB defaults so the returned row is complete
        for the typed record without a follow-up read.
        """
        stamp = now_iso()
        rows = result_rows(
            self._client.table("gateway_identities")
            .insert(
                {
                    "identity_id": identity_id,
                    "org_id": org_id,
                    "display_name": display_name,
                    "description": description,
                    "active": True,
                    "created_at": stamp,
                    "updated_at": stamp,
                }
            )
            .execute()
        )
        return IdentityRecord.model_validate(rows[0])

    def update_identity(
        self,
        *,
        org_id: str,
        identity_id: str,
        changes: dict[str, object],
    ) -> IdentityRecord | None:
        """Apply a partial update to one identity and return the new row.

        Args:
            org_id: Owning organization uuid (scopes the update).
            identity_id: Identity to change.
            changes: Column subset to set; ``updated_at`` is stamped here.

        Returns:
            The updated row, or None if no matching identity exists.
        """
        payload = dict(changes)
        # PostgREST does not evaluate SQL defaults on update, so stamp a real
        # ISO instant rather than leaning on the column default.
        payload["updated_at"] = now_iso()
        rows = result_rows(
            self._client.table("gateway_identities")
            .update(payload)
            .eq("org_id", org_id)
            .eq("identity_id", identity_id)
            .execute()
        )
        return IdentityRecord.model_validate(rows[0]) if rows else None

    def _active_key_counts(self, org_id: str) -> dict[str, int]:
        """Count unrevoked api_keys per identity for one org."""
        rows = result_rows(
            self._client.table("api_keys")
            .select("identity_id")
            .eq("org_id", org_id)
            .is_("revoked_at", "null")
            .execute()
        )
        counts: dict[str, int] = {}
        for row in rows:
            identity = row.get("identity_id")
            if isinstance(identity, str):
                counts[identity] = counts.get(identity, 0) + 1
        return counts

    # -- Grants (identity x alias) -----------------------------------------

    def list_grantable_aliases(self, org_id: str) -> tuple[AliasSummary, ...]:
        """List active aliases usable by the org (public + its own).

        These are the columns of the grant matrix and the set an add-grant is
        allowed to target, mirroring the pre-cutover rule predicate an alias was
        usable under (active AND (public OR own-org)).
        """
        rows = result_rows(
            self._client.table("gateway_aliases")
            .select("alias_id, alias_name, origin, org_id")
            .eq("active", True)  # noqa: FBT003 - supabase eq() is positional-only
            .execute()
        )
        summaries: list[AliasSummary] = []
        for row in rows:
            row_org = row.get("org_id")
            if row_org is not None and str(row_org) != org_id:
                continue
            summaries.append(
                AliasSummary(
                    alias_id=str(row["alias_id"]),
                    alias_name=str(row["alias_name"]),
                    origin=str(row["origin"]),
                    org_scoped=row_org is not None,
                )
            )
        # Own-org aliases before public ones, then by name, so an org's custom
        # slug that shadows a public one reads first.
        summaries.sort(key=lambda alias: (not alias.org_scoped, alias.alias_name))
        return tuple(summaries)

    def list_grants(self, org_id: str) -> tuple[GrantEdge, ...]:
        """List every grant edge owned by one org (all its identities)."""
        rows = result_rows(
            self._client.table("gateway_grants")
            .select("identity_id, alias_id")
            .eq("org_id", org_id)
            .execute()
        )
        return tuple(
            GrantEdge(identity_id=str(row["identity_id"]), alias_id=str(row["alias_id"]))
            for row in rows
        )

    def add_grant(self, *, org_id: str, identity_id: str, alias_id: str) -> bool:
        """Add one grant edge; return whether it was newly created.

        Idempotent and race-safe: the write is an ``ON CONFLICT DO NOTHING``
        upsert on the ``(identity_id, alias_id)`` primary key, so two concurrent
        grants of the same edge both resolve to the unchanged outcome instead of
        one raising a duplicate-key error. WMO's NaturalMutationOutcome.changed
        is reported from whether this call actually inserted the row (a row is
        returned only when no conflicting edge already existed).
        """
        rows = result_rows(
            self._client.table("gateway_grants")
            .upsert(
                {"org_id": org_id, "identity_id": identity_id, "alias_id": alias_id},
                on_conflict="identity_id,alias_id",
                ignore_duplicates=True,
            )
            .execute()
        )
        return bool(rows)

    def remove_grant(self, *, identity_id: str, alias_id: str) -> bool:
        """Remove one grant edge; return whether a row was deleted."""
        query = self._client.table("gateway_grants")
        if not isinstance(query, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        rows = result_rows(
            query.delete().eq("identity_id", identity_id).eq("alias_id", alias_id).execute()
        )
        return bool(rows)

    # -- Budgets ------------------------------------------------------------

    def list_budgets(self, org_id: str, period: str) -> tuple[BudgetBalance, ...]:
        """List an org's budgets for a month with reserved/settled balances.

        Reads the SECURITY DEFINER balances seam, which computes spend from
        gateway_attempts with the enforcement helper's scope resolution, so the
        meter never disagrees with the reservation gate.
        """
        rows = result_rows(
            self._client.rpc(
                "gateway_budget_balances",
                {"p_org_id": org_id, "p_period": period},
            ).execute()
        )
        return tuple(BudgetBalance.model_validate(row) for row in rows)

    def get_budget(self, org_id: str, budget_id: str) -> BudgetRecord | None:
        """Return one budget row scoped to its org, or None."""
        rows = result_rows(
            self._client.table("gateway_budgets")
            .select(_BUDGET_COLUMNS)
            .eq("org_id", org_id)
            .eq("budget_id", budget_id)
            .limit(1)
            .execute()
        )
        return BudgetRecord.model_validate(rows[0]) if rows else None

    def find_budget_for_scope(
        self,
        *,
        org_id: str,
        period: str,
        scope_kind: str,
        api_key_id: str | None,
        identity_id: str | None,
        alias_id: str | None,
        pool_id: str | None,
        deployment_id: str | None,
    ) -> BudgetRecord | None:
        """Return the existing budget for an exact scope, or None.

        The DB carries a unique index over (org, period, scope, coalesced
        identifiers); this locates that same row so a PUT updates in place
        rather than colliding.
        """
        query = (
            self._client.table("gateway_budgets")
            .select(_BUDGET_COLUMNS)
            .eq("org_id", org_id)
            .eq("period", period)
            .eq("scope_kind", scope_kind)
        )
        for column, value in (
            ("api_key_id", api_key_id),
            ("identity_id", identity_id),
            ("alias_id", alias_id),
            ("pool_id", pool_id),
            ("deployment_id", deployment_id),
        ):
            query = query.eq(column, value) if value is not None else query.is_(column, "null")
        rows = result_rows(query.limit(1).execute())
        return BudgetRecord.model_validate(rows[0]) if rows else None

    def upsert_budget(
        self,
        *,
        org_id: str,
        period: str,
        scope_kind: str,
        limit_micro_usd: int,
        api_key_id: str | None,
        identity_id: str | None,
        alias_id: str | None,
        pool_id: str | None,
        deployment_id: str | None,
    ) -> BudgetRecord:
        """Set the monthly limit for one scope, creating or replacing the row.

        A scope's budget is a single value per period, so an existing row for
        the exact scope has its limit raised or lowered in place; otherwise a
        new row is inserted with a fresh budget_id. The scope's uniqueness
        lives in an expression index PostgREST upsert cannot target, so two
        concurrent PUTs race the insert; the loser lands on the unique
        violation and settles by updating the winner's row.
        """
        for _ in range(2):
            existing = self.find_budget_for_scope(
                org_id=org_id,
                period=period,
                scope_kind=scope_kind,
                api_key_id=api_key_id,
                identity_id=identity_id,
                alias_id=alias_id,
                pool_id=pool_id,
                deployment_id=deployment_id,
            )
            if existing is not None:
                rows = result_rows(
                    self._client.table("gateway_budgets")
                    .update({"limit_micro_usd": limit_micro_usd, "updated_at": now_iso()})
                    .eq("budget_id", existing.budget_id)
                    .execute()
                )
                return BudgetRecord.model_validate(rows[0])
            try:
                rows = result_rows(
                    self._client.table("gateway_budgets")
                    .insert(
                        {
                            "budget_id": f"budget-{uuid.uuid4().hex}",
                            "org_id": org_id,
                            "period": period,
                            "scope_kind": scope_kind,
                            "api_key_id": api_key_id,
                            "identity_id": identity_id,
                            "alias_id": alias_id,
                            "pool_id": pool_id,
                            "deployment_id": deployment_id,
                            "limit_micro_usd": limit_micro_usd,
                        }
                    )
                    .execute()
                )
            except Exception as error:
                if not is_unique_violation(error):
                    raise
                continue
            return BudgetRecord.model_validate(rows[0])
        msg = "budget upsert lost the insert race twice for one scope"
        raise RepositoryError(msg)

    def delete_budget(self, *, org_id: str, budget_id: str) -> bool:
        """Remove one budget row; return whether a row was deleted."""
        query = self._client.table("gateway_budgets")
        if not isinstance(query, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        rows = result_rows(query.delete().eq("org_id", org_id).eq("budget_id", budget_id).execute())
        return bool(rows)
