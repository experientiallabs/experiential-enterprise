# Copyright (c) 2026 Experiential Labs. All rights reserved.

r"""Load a production catalog dump into a LOCAL stack database.

The local docker stack runs no provider discovery, so its catalog is only the
~66 seeded launch models while production carries the full multi-provider
discovery catalog (500+). This loader imports a production dump CSV (the
``\\copy`` of ``public.models`` joined to ``public.model_providers``) into a
local database so a local preview mirrors the full catalog.

The import mirrors the POST-DEDUP canonical state, not the raw legacy rows: a
dump row whose model slug is a legacy provider-namespaced duplicate
(``fireworks-*`` / ``azure_openai-*`` / ``bedrock-*``) is re-homed onto its
canonical model via :mod:`explabs.gateway.model_aliases` +
:func:`explabs.gateway.model_identity.canonicalize` — exactly the mapping the
cross-provider dedup migration applies to production — so one real model lands
as ONE local model with all its provider lanes. Rows on a clean (curated) slug
keep their model as-is, preserving deliberate lane choices.

Idempotent: models upsert by slug (existing seeded rows keep their curated
metadata), provider rows upsert on their identity key, and a rung-0 default
waterfall is created only where a model has none. SAFETY: refuses to run against
anything but a localhost database — this tool must never touch production.

Usage:
    UV_CACHE_DIR=/tmp/.uv-cache uv run python scripts/load_catalog_dump.py \\
        --csv /tmp/catalog_full_dump.csv \\
        [--database-url postgresql://postgres:postgres@127.0.0.1:54332/postgres]
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import psycopg

from explabs.gateway.model_aliases import resolve_canonical_slug
from explabs.gateway.model_identity import canonicalize

_DEFAULT_LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54332/postgres"
_LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_LEGACY_NAMESPACE = re.compile(r"^(fireworks|azure_openai|bedrock)-")


@dataclass(frozen=True)
class DumpRow:
    """One provider row from the production catalog dump."""

    model_slug: str
    display_name: str
    category: str | None
    preferred_rank: int | None
    provider: str
    provider_model_id: str
    billing_source: str
    status: str
    input_micro: int | None
    output_micro: int | None

    @classmethod
    def from_csv(cls, raw: dict[str, str]) -> DumpRow:
        """Validate one CSV row at the file boundary."""

        def opt_int(value: str) -> int | None:
            value = value.strip()
            return int(value) if value else None

        return cls(
            model_slug=raw["model_slug"].strip(),
            display_name=raw["display_name"].strip(),
            category=raw["category"].strip() or None,
            preferred_rank=opt_int(raw["preferred_rank"]),
            provider=raw["provider"].strip(),
            provider_model_id=raw["provider_model_id"].strip(),
            billing_source=raw["billing_source"].strip(),
            status=raw["status"].strip(),
            input_micro=opt_int(raw["input_micro_usd_per_million"]),
            output_micro=opt_int(raw["output_micro_usd_per_million"]),
        )


def canonical_slug_for(row: DumpRow) -> str:
    """The local model slug a dump row lands under (the post-dedup canonical).

    A clean (curated) slug is kept verbatim — that preserves deliberate lane
    choices like a base model's pinned snapshot fallback. A legacy namespaced
    duplicate re-homes onto the alias map's canonical, falling back to the
    deterministic canonicalize slug (what the current sync would mint).
    """
    if not _LEGACY_NAMESPACE.match(row.model_slug):
        return row.model_slug
    alias = resolve_canonical_slug(row.provider, row.provider_model_id)
    if alias is not None:
        return alias
    return canonicalize(row.provider, row.provider_model_id, row.display_name).slug


def require_local(database_url: str) -> None:
    """Hard-refuse any non-localhost database; this tool never touches prod."""
    host = urlparse(database_url).hostname or ""
    if host not in _LOCAL_HOSTS:
        print(
            f"refusing to run against non-local host {host!r}; "
            "this loader is for the local stack only",
            file=sys.stderr,
        )
        raise SystemExit(2)


def load_dump(connection: psycopg.Connection[tuple[object, ...]], rows: list[DumpRow]) -> None:
    """Upsert the dump into the local catalog, canonicalized, in one txn."""
    created_models = 0
    upserted_routes = 0
    # Clean-slug rows first: when several dump rows collapse onto one canonical
    # model that the seed did NOT create, the model row is minted by the FIRST
    # row processed — a clean row carries the human display name ("Inkling"),
    # a legacy dup carries a lane-decorated one ("Fw Inkling (Azure Foundry)").
    ordered = sorted(rows, key=lambda row: bool(_LEGACY_NAMESPACE.match(row.model_slug)))
    with connection.transaction():
        for row in ordered:
            slug = canonical_slug_for(row)
            # Display name: a clean row keeps its human name; a re-homed legacy
            # dup carries a lane-decorated one ("Fw Glm 4.7 (Azure Foundry)"),
            # so derive a provider-agnostic display by prettifying the canonical
            # slug instead. Existing (seeded) models keep their curated fields
            # untouched either way (insert is do-nothing on conflict).
            if _LEGACY_NAMESPACE.match(row.model_slug) or not row.display_name:
                display = canonicalize("openrouter", slug, slug).display_name
            else:
                display = row.display_name
            inserted = connection.execute(
                """
                insert into public.models (slug, display_name, category, preferred_rank)
                values (%s, %s, %s, %s)
                on conflict (slug, owning_org_id) do nothing
                returning id
                """,
                (slug, display, row.category, row.preferred_rank),
            ).fetchone()
            if inserted is not None:
                created_models += 1
            connection.execute(
                """
                insert into public.model_providers (
                    model_id, provider, provider_model_id, billing_source, status,
                    input_micro_usd_per_million, output_micro_usd_per_million,
                    pricing_source, capabilities
                )
                select m.id, %(provider)s, %(wire)s, %(billing)s, %(status)s,
                       %(input)s, %(output)s,
                       case when %(input)s::bigint is not null then 'estimate' end,
                       '{"supports_streaming": true}'::jsonb
                from public.models m
                where m.slug = %(slug)s and m.owning_org_id is null
                on conflict (model_id, provider, provider_model_id, owning_org_id, base_url)
                do update set
                    billing_source = excluded.billing_source,
                    status = excluded.status,
                    input_micro_usd_per_million = coalesce(
                        public.model_providers.input_micro_usd_per_million,
                        excluded.input_micro_usd_per_million
                    ),
                    output_micro_usd_per_million = coalesce(
                        public.model_providers.output_micro_usd_per_million,
                        excluded.output_micro_usd_per_million
                    )
                """,
                {
                    "slug": slug,
                    "provider": row.provider,
                    "wire": row.provider_model_id,
                    "billing": row.billing_source,
                    "status": row.status,
                    "input": row.input_micro,
                    "output": row.output_micro,
                },
            )
            upserted_routes += 1
        # A rung-0 default chain for any imported model that has none, pointing
        # at its best lane, so imported models are listed and routable locally.
        connection.execute(
            """
            insert into public.model_waterfalls (model_id, position, model_provider_id)
            select distinct on (m.id) m.id, 0, mp.id
            from public.models m
            join public.model_providers mp on mp.model_id = m.id and mp.owning_org_id is null
            where m.owning_org_id is null
              and not exists (
                select 1 from public.model_waterfalls w
                where w.model_id = m.id and w.org_id is null and w.position = 0
              )
            order by m.id, (mp.status = 'active') desc,
                     (mp.input_micro_usd_per_million is not null) desc, mp.id
            on conflict (model_id, org_id, position) do nothing
            """
        )
    print(f"imported {len(rows)} provider rows; created {created_models} new models")
    print(f"upserted {upserted_routes} routes; rung-0 chains ensured for chainless models")


def main() -> None:
    """Parse args, validate the target is local, and import the dump."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, type=Path, help="Path to the catalog dump CSV")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("SUPABASE_DB_URL", _DEFAULT_LOCAL_URL),
        help="Local database URL (defaults to SUPABASE_DB_URL or the docker stack)",
    )
    args = parser.parse_args()
    require_local(args.database_url)

    with args.csv.open(newline="") as handle:
        rows = [
            DumpRow.from_csv(raw)
            for raw in csv.DictReader(handle)
            # Private (org-owned) rows never import: the dump is the public catalog.
            if not raw.get("owning_org_id", "").strip()
        ]
    print(f"loaded {len(rows)} public provider rows from {args.csv}")

    with psycopg.connect(args.database_url) as connection:
        load_dump(connection, rows)


if __name__ == "__main__":
    main()
