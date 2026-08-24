# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Integration proof for named / abstract aliases (identity tier P-E).

Exercises the whole named-alias mechanic against real Postgres: build the
catalog for two models, point an admin-managed alias "coding" at model A,
resolve it through the control store the way a /v1 request would, repoint it to
model B, roll it back to A, and prove the catalog builder skips synthesizing a
catalog alias for a model whose (name, org) a named alias already owns.
"""

from __future__ import annotations

import hashlib
import os
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import cast

import psycopg
import pytest
from exp.runtime.gateway.contracts import DirectTarget
from psycopg.types.json import Jsonb

from explabs.gateway.catalog import (
    CatalogStoreResult,
    GatewayCatalogRefresher,
    build_gateway_catalog,
    load_catalog_rows,
    store_gateway_catalog,
)
from explabs.gateway.control_store import PostgresGatewayControlStore
from explabs.gateway.control_store_test import _request
from explabs.gateway.db import GatewayDatabase


def _database_url() -> str:
    """Return the disposable integration database URL or skip."""
    value = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not value:
        pytest.skip("SUPABASE_DB_URL is required for integration tests")
    return value


@dataclass(frozen=True)
class _NamedAliasFixture:
    """Run-unique identities for one named-alias integration pass."""

    suffix: str
    org_id: str
    model_a: str
    model_b: str
    raw_key: str

    @property
    def slug_a(self) -> str:
        return f"pe-model-a-{self.suffix}"

    @property
    def slug_b(self) -> str:
        return f"pe-model-b-{self.suffix}"

    def environment(self) -> dict[str, str]:
        # Presence-only: the host_managed lane admits the deployments; values
        # never enter the catalog build.
        return {
            "OPENAI_API_KEY": f"pe-openai-{self.suffix}",
            "ANTHROPIC_API_KEY": f"pe-anthropic-{self.suffix}",
        }


@dataclass(frozen=True)
class _CatalogRevision:
    """A model's current catalog alias revision, as the API reads it."""

    target: dict[str, object]
    catalog_sha256: str
    provider_connection_revisions: dict[str, object]
    certification: dict[str, object] | None
    refusal_failover: bool


def _seed(setup: psycopg.Connection[tuple[object, ...]], fixture: _NamedAliasFixture) -> None:
    """Seed one org, one API key, and two public host_managed models."""
    setup.execute(
        "insert into public.organizations (id, slug, name) values (%s, %s, 'PE Named Alias')",
        (fixture.org_id, f"pe-org-{fixture.suffix}"),
    )
    # Deny-by-default (P-B): the key hangs off the org's default identity, and the
    # named alias must be granted to it (see _activate_named). Seed the identity as
    # P-A's backfill does (id 'org-' || org_id) and reparent the key onto it.
    setup.execute(
        "insert into public.gateway_identities (identity_id, org_id, display_name)"
        " values (%s, %s, 'Default') on conflict (identity_id) do nothing",
        (f"org-{fixture.org_id}", fixture.org_id),
    )
    setup.execute(
        """
        insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by, identity_id)
        values (%s, %s, 'pe-key', %s, %s, null, %s)
        """,
        (
            str(uuid.uuid4()),
            fixture.org_id,
            fixture.raw_key[:12],
            hashlib.sha256(fixture.raw_key.encode()).hexdigest(),
            f"org-{fixture.org_id}",
        ),
    )
    setup.execute(
        """
        insert into public.models (id, slug, display_name, owning_org_id) values
          (%s, %s, 'PE Model A', null), (%s, %s, 'PE Model B', null)
        """,
        (fixture.model_a, fixture.slug_a, fixture.model_b, fixture.slug_b),
    )
    setup.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, billing_source, owning_org_id,
          input_micro_usd_per_million, output_micro_usd_per_million, created_at
        ) values
          (%s, %s, 'openai', 'gpt-5', 'host_managed', null, 2500000, 10000000, now()),
          (%s, %s, 'anthropic', 'claude-opus-5', 'host_managed', null, 3000000, 15000000, now())
        """,
        (str(uuid.uuid4()), fixture.model_a, str(uuid.uuid4()), fixture.model_b),
    )


def _catalog_revision(
    setup: psycopg.Connection[tuple[object, ...]], model_id: str
) -> _CatalogRevision:
    """Read the current catalog alias revision the builder created for a model."""
    row = setup.execute(
        """
        select r.target, r.catalog_sha256, r.provider_connection_revisions,
               r.certification, r.refusal_failover
          from public.gateway_aliases a
          join public.gateway_alias_revisions r on r.revision_id = a.current_revision_id
         where a.alias_id = %s and a.active
        """,
        (f"model-{model_id}",),
    ).fetchone()
    assert row is not None, f"model {model_id} has no active catalog alias"
    target, catalog_sha256, pcr, certification, refusal_failover = row
    return _CatalogRevision(
        target=cast("dict[str, object]", target),
        catalog_sha256=str(catalog_sha256),
        provider_connection_revisions=cast("dict[str, object]", pcr),
        certification=None if certification is None else cast("dict[str, object]", certification),
        refusal_failover=bool(refusal_failover),
    )


def _activate_named(
    setup: psycopg.Connection[tuple[object, ...]],
    *,
    alias_id: str,
    org_id: str,
    revision_id: str,
    revision: _CatalogRevision,
    model_id: str,
    model_slug: str,
) -> None:
    """Activate one named-alias revision through the P-E RPC."""
    setup.execute(
        """
        select changed from public.gateway_activate_named_alias_revision(
          %s, 'coding', %s, %s, %s, %s, %s, %s, %s, %s, %s
        )
        """,
        (
            alias_id,
            org_id,
            revision_id,
            Jsonb(revision.target),
            revision.catalog_sha256,
            Jsonb(revision.provider_connection_revisions),
            None if revision.certification is None else Jsonb(revision.certification),
            revision.refusal_failover,
            model_id,
            model_slug,
        ),
    )
    # Deny-by-default (P-B): grant the org's default identity this named alias so
    # authorize_request resolves it. Idempotent across repoint/rollback re-activation.
    setup.execute(
        """
        insert into public.gateway_grants (org_id, identity_id, alias_id)
        values (%s, %s, %s) on conflict do nothing
        """,
        (org_id, f"org-{org_id}", alias_id),
    )


@pytest.fixture
def seeded_alias() -> Iterator[tuple[str, _NamedAliasFixture]]:
    """Seed the fixture on real Postgres and remove it afterwards."""
    url = _database_url()
    fixture = _NamedAliasFixture(
        suffix=uuid.uuid4().hex[:8],
        org_id=str(uuid.uuid4()),
        model_a=str(uuid.uuid4()),
        model_b=str(uuid.uuid4()),
        raw_key=f"xpl_pe_{uuid.uuid4().hex}",
    )
    setup = psycopg.connect(url, autocommit=True)
    try:
        _seed(setup, fixture)
        yield url, fixture
    finally:
        _cleanup(setup, fixture)
        setup.close()


def _cleanup(setup: psycopg.Connection[tuple[object, ...]], fixture: _NamedAliasFixture) -> None:
    """Remove every seeded and derived row, append-only triggers disabled."""
    setup.execute("set session_replication_role = replica")
    try:
        setup.execute(
            """
            delete from public.gateway_named_alias_targets
             where alias_id in (
               select alias_id from public.gateway_aliases where org_id = %s
             )
            """,
            (fixture.org_id,),
        )
        setup.execute(
            """
            delete from public.gateway_alias_revisions
             where alias_id in (
               select alias_id from public.gateway_aliases
                where org_id = %s or alias_id in (%s, %s)
             )
            """,
            (fixture.org_id, f"model-{fixture.model_a}", f"model-{fixture.model_b}"),
        )
        setup.execute(
            "delete from public.gateway_aliases where org_id = %s or alias_id in (%s, %s)",
            (fixture.org_id, f"model-{fixture.model_a}", f"model-{fixture.model_b}"),
        )
        setup.execute(
            "delete from public.model_providers where model_id in (%s, %s)",
            (fixture.model_a, fixture.model_b),
        )
        setup.execute(
            "delete from public.models where id in (%s, %s)",
            (fixture.model_a, fixture.model_b),
        )
        setup.execute("delete from public.api_keys where org_id = %s", (fixture.org_id,))
        setup.execute("delete from public.gateway_grants where org_id = %s", (fixture.org_id,))
        setup.execute("delete from public.gateway_identities where org_id = %s", (fixture.org_id,))
        setup.execute("delete from public.credit_ledger where org_id = %s", (fixture.org_id,))
        setup.execute("delete from public.organizations where id = %s", (fixture.org_id,))
    finally:
        setup.execute("set session_replication_role = origin")


@pytest.mark.integration
def test_named_alias_resolves_repoints_and_rolls_back(
    seeded_alias: tuple[str, _NamedAliasFixture], gateway_db: GatewayDatabase
) -> None:
    """Coding -> A resolves; repoint -> B; rollback -> A, all via the control store."""
    url, fixture = seeded_alias
    setup = psycopg.connect(url, autocommit=True)
    try:
        assert (
            GatewayCatalogRefresher(
                lambda: psycopg.connect(url), environment=fixture.environment()
            ).refresh_now()
            is True
        )
        revision_a = _catalog_revision(setup, fixture.model_a)
        revision_b = _catalog_revision(setup, fixture.model_b)
        pool_a = str(revision_a.target["pool_id"])
        pool_b = str(revision_b.target["pool_id"])
        assert pool_a != pool_b

        store = PostgresGatewayControlStore(gateway_db)
        alias_id = f"named-{uuid.uuid4().hex}"

        # Create: coding -> model A.
        revision_a_id = f"nrev-{uuid.uuid4().hex}"
        _activate_named(
            setup,
            alias_id=alias_id,
            org_id=fixture.org_id,
            revision_id=revision_a_id,
            revision=revision_a,
            model_id=fixture.model_a,
            model_slug=fixture.slug_a,
        )
        snapshot = store.authorize_request(
            raw_key=fixture.raw_key,
            alias="coding",
            request=_request("hello"),
            deadline_monotonic=time.monotonic() + 30,
        )
        assert snapshot.alias == "coding"
        assert snapshot.target == DirectTarget(pool_id=pool_a)

        # Repoint: coding -> model B (new revision).
        _activate_named(
            setup,
            alias_id=alias_id,
            org_id=fixture.org_id,
            revision_id=f"nrev-{uuid.uuid4().hex}",
            revision=revision_b,
            model_id=fixture.model_b,
            model_slug=fixture.slug_b,
        )
        snapshot = store.authorize_request(
            raw_key=fixture.raw_key,
            alias="coding",
            request=_request("hello"),
            deadline_monotonic=time.monotonic() + 30,
        )
        assert snapshot.target == DirectTarget(pool_id=pool_b)

        # Rollback: re-activate the original revision A.
        _activate_named(
            setup,
            alias_id=alias_id,
            org_id=fixture.org_id,
            revision_id=revision_a_id,
            revision=revision_a,
            model_id=fixture.model_a,
            model_slug=fixture.slug_a,
        )
        snapshot = store.authorize_request(
            raw_key=fixture.raw_key,
            alias="coding",
            request=_request("hello"),
            deadline_monotonic=time.monotonic() + 30,
        )
        assert snapshot.target == DirectTarget(pool_id=pool_a)

        # History carries one revision per repoint event, newest models named.
        history = setup.execute(
            """
            select t.model_slug
              from public.gateway_named_alias_targets t
             where t.alias_id = %s
             order by t.created_at
            """,
            (alias_id,),
        ).fetchall()
        assert [str(row[0]) for row in history] == [fixture.slug_a, fixture.slug_b]
    finally:
        setup.close()


def _rebuild_catalog(url: str, environment: dict[str, str]) -> CatalogStoreResult:
    """Load rows, build, and store the gateway catalog on a fresh connection."""
    connection = psycopg.connect(url)
    try:
        rows = load_catalog_rows(connection)
        build = build_gateway_catalog(rows, environment=environment)
        return store_gateway_catalog(connection, build)
    finally:
        connection.close()


def _seed_shadow_model(setup: psycopg.Connection, fixture: _NamedAliasFixture) -> str:
    """Seed an org-owned model whose slug "coding" collides with a named alias.

    The private model routes through the org's own BYOK connection (a private
    model's deployment must be owned by the model's org). Returns the model id.
    """
    setup.execute(
        "select * from public.upsert_provider_connection(%s, 'openai', '{}'::jsonb, %s)",
        (fixture.org_id, f"pe-shadow-{fixture.suffix}"),
    )
    shadow_model = str(uuid.uuid4())
    setup.execute(
        "insert into public.models (id, slug, display_name, owning_org_id) values (%s, 'coding', 'Shadow', %s)",
        (shadow_model, fixture.org_id),
    )
    setup.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, billing_source, owning_org_id,
          input_micro_usd_per_million, output_micro_usd_per_million, created_at
        ) values (%s, %s, 'openai', 'gpt-5', 'customer_managed', %s, 2500000, 10000000, now())
        """,
        (str(uuid.uuid4()), shadow_model, fixture.org_id),
    )
    return shadow_model


def _count_catalog_coding(setup: psycopg.Connection, org_id: str) -> int:
    """Number of builder-synthesized catalog aliases named "coding" for the org."""
    row = setup.execute(
        """
        select count(*) from public.gateway_aliases
         where alias_name = 'coding' and org_id = %s and origin = 'catalog'
        """,
        (org_id,),
    ).fetchone()
    assert row is not None
    return int(row[0])


@pytest.mark.integration
def test_catalog_builder_skips_model_shadowed_by_named_alias(
    seeded_alias: tuple[str, _NamedAliasFixture], gateway_db: GatewayDatabase
) -> None:
    """A named alias shadows an org model by row existence, retire and all.

    While active the builder skips the colliding catalog alias. After the alias
    is retired the row persists (for rollback) and still holds the (name, org)
    namespace, so the builder must KEEP skipping it: the shadow set is scoped by
    row existence, not `active`. Filtering on `active` here would make the
    builder attempt the shadowed model's catalog alias against the still-present
    row, hit the row-based 23505 collision, and abort every refresh tick —
    freezing gateway-wide routing. This proves the rebuild stays clean.
    """
    url, fixture = seeded_alias
    setup = psycopg.connect(url, autocommit=True)
    try:
        GatewayCatalogRefresher(
            lambda: psycopg.connect(url), environment=fixture.environment()
        ).refresh_now()
        revision_a = _catalog_revision(setup, fixture.model_a)
        alias_id = f"named-{uuid.uuid4().hex}"
        _activate_named(
            setup,
            alias_id=alias_id,
            org_id=fixture.org_id,
            revision_id=f"nrev-{uuid.uuid4().hex}",
            revision=revision_a,
            model_id=fixture.model_a,
            model_slug=fixture.slug_a,
        )
        shadow_model = _seed_shadow_model(setup, fixture)
        try:
            # The named alias owns "coding" for this org, so the catalog alias
            # for the shadow model is skipped rather than aborting the build.
            result = _rebuild_catalog(url, fixture.environment())
            assert "coding" in result.named_alias_shadowed
            assert _count_catalog_coding(setup, fixture.org_id) == 0

            # And "coding" still resolves to the admin-managed target (model A).
            store = PostgresGatewayControlStore(gateway_db)
            snapshot = store.authorize_request(
                raw_key=fixture.raw_key,
                alias="coding",
                request=_request("hello"),
                deadline_monotonic=time.monotonic() + 30,
            )
            assert snapshot.target == DirectTarget(pool_id=str(revision_a.target["pool_id"]))

            # Retiring the alias leaves its row in place (rollback history), so
            # it still holds the (name, org) namespace. The rebuild must stay
            # clean and KEEP shadowing "coding": if it tried to synthesize the
            # model's catalog alias it would hit the row-based 23505 and this
            # _rebuild_catalog call would raise, wedging every future refresh.
            setup.execute("select public.gateway_deactivate_alias(%s)", (alias_id,))
            result_after_retire = _rebuild_catalog(url, fixture.environment())
            assert "coding" in result_after_retire.named_alias_shadowed
            assert _count_catalog_coding(setup, fixture.org_id) == 0
        finally:
            setup.execute("set session_replication_role = replica")
            try:
                setup.execute(
                    "delete from public.gateway_alias_revisions where alias_id = %s",
                    (f"model-{shadow_model}",),
                )
                setup.execute(
                    "delete from public.gateway_aliases where alias_id = %s",
                    (f"model-{shadow_model}",),
                )
                setup.execute(
                    "delete from public.model_providers where model_id = %s", (shadow_model,)
                )
                setup.execute("delete from public.models where id = %s", (shadow_model,))
                setup.execute(
                    "delete from public.provider_connections where org_id = %s", (fixture.org_id,)
                )
            finally:
                setup.execute("set session_replication_role = origin")
    finally:
        setup.close()
