# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Shared integration fixtures seeding gateway authority in real Postgres."""

from __future__ import annotations

import hashlib
import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import LiteralString

import psycopg
import pytest
from psycopg.types.json import Jsonb

from explabs.gateway.db import GatewayDatabase


def _database_url() -> str:
    """Return the explicitly configured disposable integration database URL."""
    value = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not value:
        pytest.skip("SUPABASE_DB_URL is required for integration tests")
    return value


@dataclass(frozen=True)
class SeededKey:
    """One seeded platform API key with its raw secret."""

    api_key_id: str
    raw_key: str


@dataclass(frozen=True)
class SeededAlias:
    """One activated gateway alias with its frozen revision identity."""

    alias_id: str
    alias_name: str
    revision_id: str
    catalog_sha256: str
    pool_id: str


class GatewayHarness:
    """Seed and remove isolated gateway fixture rows on one autocommit session.

    Every id is unique per instance so concurrent stacks and dirty databases
    never collide; teardown removes exactly what was seeded, using replica
    mode to pass the append-only triggers.
    """

    def __init__(self, dsn: str) -> None:
        """Open one autocommit control connection.

        Args:
            dsn: PostgreSQL connection URL.
        """
        self.connection: psycopg.Connection = psycopg.connect(dsn, autocommit=True)
        self._org_ids: list[str] = []
        self._alias_ids: list[str] = []
        self._catalog_sha256s: list[str] = []
        self._protocol_org_ids: list[str] = []

    def track_protocol_org(self, organization_id: str) -> None:
        """Register one protocol-namespace organization id for teardown.

        Args:
            organization_id: Experiential artifact id used as a replay/continuation
                namespace boundary (no FK; cleanup is by this value).
        """
        self._protocol_org_ids.append(organization_id)

    def seed_org(self, *, drained: bool = False) -> str:
        """Insert one organization and return its uuid.

        New organizations receive the $20 welcome grant from the signup-promo
        trigger; ``drained`` spends the whole grant so the balance gate blocks.

        Args:
            drained: Whether the org starts with an exhausted credit balance.
        """
        org_id = str(uuid.uuid4())
        self.connection.execute(
            """
            insert into public.organizations (id, slug, name)
            values (%s, %s, 'Gateway P2 Integration')
            """,
            (org_id, f"gw-int-{org_id[:13]}"),
        )
        # Mirror the identity-tier cutover: every org owns a default identity
        # whose id is exactly the control store's synthetic 'org-' || org_id, so
        # reparented keys and the grant join see identical authority to today.
        self.connection.execute(
            """
            insert into public.gateway_identities (identity_id, org_id, display_name)
            values ('org-' || %s, %s, 'Default')
            on conflict (identity_id) do nothing
            """,
            (org_id, org_id),
        )
        if drained:
            self.connection.execute(
                """
                update public.organizations
                   set billable_spend_usd = credit_granted_usd
                 where id = %s
                """,
                (org_id,),
            )
        self._org_ids.append(org_id)
        return org_id

    def seed_key(
        self,
        org_id: str,
        *,
        revoked: bool = False,
        expires_at: datetime | None = None,
        created_by: str | None = None,
    ) -> SeededKey:
        """Insert one API key and return its id with the raw secret.

        Args:
            org_id: Owning organization uuid.
            revoked: Whether the key starts revoked.
            expires_at: Optional expiry instant.
            created_by: Optional creating-user uuid for usage attribution.
        """
        api_key_id = str(uuid.uuid4())
        raw_key = f"xpl_test_{uuid.uuid4().hex}"
        # Reparent the key onto its org's default identity, exactly as the
        # cutover backfill does; the grant join keys on this value.
        self.connection.execute(
            """
            insert into public.api_keys (
              id, org_id, name, key_prefix, key_hash, created_by,
              revoked_at, expires_at, identity_id
            ) values (
              %s, %s, 'gateway-int', %s, %s, %s,
              case when %s then now() end, %s, 'org-' || %s
            )
            """,
            (
                api_key_id,
                org_id,
                raw_key[:12],
                hashlib.sha256(raw_key.encode()).hexdigest(),
                created_by,
                revoked,
                expires_at,
                org_id,
            ),
        )
        return SeededKey(api_key_id=api_key_id, raw_key=raw_key)

    def activate_alias(
        self,
        *,
        org_id: str | None = None,
        alias_name: str | None = None,
        seed_grants: bool = True,
    ) -> SeededAlias:
        """Register one catalog snapshot and activate one direct alias on it.

        Args:
            org_id: Owning organization for a custom model; None = public.
            alias_name: Explicit slug for shadowing tests; default is unique.
            seed_grants: Whether to grant the new alias to the default identity
                of every org for which it is usable under the pre-cutover rule
                predicate (public -> all seeded orgs; org-scoped -> that org).
                This reproduces the migration's cutover grant seed; set False to
                exercise deny-by-default on a granted-nothing alias.
        """
        suffix = uuid.uuid4().hex[:12]
        catalog_sha256 = hashlib.sha256(f"gateway-int-{suffix}".encode()).hexdigest()
        alias = SeededAlias(
            alias_id=f"alias-{suffix}",
            alias_name=alias_name if alias_name is not None else f"gwm-{suffix}",
            revision_id=f"revision-{suffix}",
            catalog_sha256=catalog_sha256,
            pool_id=f"pool-{suffix}",
        )
        self.connection.execute(
            "select public.gateway_register_catalog_snapshot(%s, %s, %s)",
            (
                catalog_sha256,
                Jsonb({"deployments": [f"dep-{suffix}"]}),
                Jsonb({"models": []}),
            ),
        )
        self.connection.execute(
            "select public.gateway_activate_alias_revision(%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                alias.alias_id,
                alias.alias_name,
                org_id,
                alias.revision_id,
                Jsonb({"kind": "direct", "pool_id": alias.pool_id}),
                catalog_sha256,
                Jsonb({}),
                None,
                False,
            ),
        )
        self._alias_ids.append(alias.alias_id)
        self._catalog_sha256s.append(catalog_sha256)
        if seed_grants:
            grantee_org_ids = self._org_ids if org_id is None else [org_id]
            for grantee_org_id in grantee_org_ids:
                self.grant_alias(f"org-{grantee_org_id}", alias.alias_id, org_id=grantee_org_id)
        return alias

    def grant_alias(self, identity_id: str, alias_id: str, *, org_id: str) -> None:
        """Grant one alias to one identity (idempotent), the P-B read key."""
        self.connection.execute(
            """
            insert into public.gateway_grants (org_id, identity_id, alias_id)
            values (%s, %s, %s)
            on conflict do nothing
            """,
            (org_id, identity_id, alias_id),
        )

    def deactivate_alias(self, alias_id: str) -> None:
        """Retire one alias through its sanctioned write path."""
        self.connection.execute("select public.gateway_deactivate_alias(%s)", (alias_id,))

    def set_key_limits(
        self,
        api_key_id: str,
        *,
        daily_spend_cap_micro_usd: int | None,
        requests_per_minute: int | None,
        tokens_per_minute: int | None = None,
    ) -> None:
        """Write one explicit per-key guardrail row (the control-API-owned table)."""
        self.connection.execute(
            """
            insert into public.gateway_key_limits (
              api_key_id, daily_spend_cap_micro_usd, requests_per_minute,
              tokens_per_minute
            ) values (%s, %s, %s, %s)
            on conflict (api_key_id) do update
              set daily_spend_cap_micro_usd = excluded.daily_spend_cap_micro_usd,
                  requests_per_minute = excluded.requests_per_minute,
                  tokens_per_minute = excluded.tokens_per_minute
            """,
            (api_key_id, daily_spend_cap_micro_usd, requests_per_minute, tokens_per_minute),
        )

    def set_budget(
        self,
        org_id: str,
        *,
        period: str,
        scope_kind: str,
        limit_micro_usd: int,
        api_key_id: str | None = None,
        identity_id: str | None = None,
        alias_id: str | None = None,
        pool_id: str | None = None,
        deployment_id: str | None = None,
    ) -> str:
        """Write one budget scope row and return its id (teardown is org-wide)."""
        budget_id = f"budget-test-{uuid.uuid4().hex}"
        self.connection.execute(
            """
            insert into public.gateway_budgets (
              budget_id, org_id, period, scope_kind, api_key_id, identity_id,
              alias_id, pool_id, deployment_id, limit_micro_usd
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                budget_id,
                org_id,
                period,
                scope_kind,
                api_key_id,
                identity_id,
                alias_id,
                pool_id,
                deployment_id,
                limit_micro_usd,
            ),
        )
        return budget_id

    def fetch_one(
        self, query: LiteralString, params: tuple[object, ...]
    ) -> tuple[object, ...] | None:
        """Read one row outside any adapter transaction."""
        return self.connection.execute(query, params).fetchone()

    def fetch_all(
        self, query: LiteralString, params: tuple[object, ...]
    ) -> list[tuple[object, ...]]:
        """Read every row outside any adapter transaction."""
        return self.connection.execute(query, params).fetchall()

    def close(self) -> None:
        """Remove every seeded row (triggers disabled) and close the session."""
        try:
            self.connection.execute("set session_replication_role = replica")
            try:
                for org_id in self._org_ids:
                    for table, column in (
                        ("gateway_usage_daily", "org_id"),
                        ("gateway_usage_events", "org_id"),
                        ("gateway_attempts", "org_id"),
                        ("gateway_requests", "org_id"),
                    ):
                        self.connection.execute(
                            f"delete from public.{table} where {column} = %s",
                            (org_id,),
                        )
                    self.connection.execute(
                        """
                        delete from public.gateway_key_limits
                        where api_key_id in (
                          select id from public.api_keys where org_id = %s
                        )
                        """,
                        (org_id,),
                    )
                    # Identity-tier rows FK the aliases deleted below, so clear
                    # them before the alias loop runs.
                    self.connection.execute(
                        "delete from public.gateway_grants where org_id = %s", (org_id,)
                    )
                    # Alert rules FK the budgets deleted next (events cascade
                    # from the rules).
                    self.connection.execute(
                        "delete from public.gateway_spend_alerts where org_id = %s",
                        (org_id,),
                    )
                    self.connection.execute(
                        "delete from public.gateway_budgets where org_id = %s", (org_id,)
                    )
                for alias_id in self._alias_ids:
                    self.connection.execute(
                        "delete from public.gateway_alias_revisions where alias_id = %s",
                        (alias_id,),
                    )
                    self.connection.execute(
                        "delete from public.gateway_aliases where alias_id = %s",
                        (alias_id,),
                    )
                for protocol_org_id in self._protocol_org_ids:
                    self.connection.execute(
                        "delete from public.gateway_replay_operations where organization_id = %s",
                        (protocol_org_id,),
                    )
                    self.connection.execute(
                        "delete from public.gateway_continuations where organization_id = %s",
                        (protocol_org_id,),
                    )
                for catalog_sha256 in self._catalog_sha256s:
                    self.connection.execute(
                        "delete from public.gateway_catalog_snapshots where catalog_sha256 = %s",
                        (catalog_sha256,),
                    )
                for org_id in self._org_ids:
                    # Replica mode also disables FK cascades, so the welcome
                    # grant ledger rows need an explicit delete.
                    self.connection.execute(
                        "delete from public.credit_ledger where org_id = %s", (org_id,)
                    )
                    self.connection.execute(
                        "delete from public.api_keys where org_id = %s", (org_id,)
                    )
                    self.connection.execute(
                        "delete from public.gateway_identities where org_id = %s", (org_id,)
                    )
                    self.connection.execute(
                        "delete from public.organizations where id = %s", (org_id,)
                    )
            finally:
                self.connection.execute("set session_replication_role = origin")
        finally:
            self.connection.close()


@pytest.fixture
def gateway_harness() -> Iterator[GatewayHarness]:
    """Yield one seeding harness bound to the integration database."""
    harness = GatewayHarness(_database_url())
    try:
        yield harness
    finally:
        harness.close()


@pytest.fixture
def gateway_db() -> Iterator[GatewayDatabase]:
    """Yield one adapter connection pool bound to the integration database."""
    db = GatewayDatabase(_database_url(), min_size=1, max_size=10)
    try:
        yield db
    finally:
        db.close()
