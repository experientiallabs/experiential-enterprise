-- Curation copy for the published default models behind the /models door
-- (the product owner, 2026-07-30: "actual numbers from the database, not just faking
-- these models", then same day: the defaults live in a workspace).
--
-- The defaults themselves are the READY ENDPOINTS of the default-models
-- workspace org (seed.sql, id 00000000-...-0003): the door and the member
-- catalog list that workspace, numbers derived per endpoint from its
-- installed improvement report, so curating what everyone sees is workspace
-- administration. A `default_models` row is optional display enrichment for
-- one workspace endpoint, keyed by slug = endpoint name: title, benchmark,
-- description, tags, catalog joins, gallery order. An endpoint without a row
-- still publishes, under its own name.
--
-- `headline` is RETIRED (seeded null, never read): a figure here would be a
-- second source of truth beside the endpoint's report, waiting to drift.
-- Latency shown anywhere for a default is p50 model time per run:
-- per-completed-task cuts of the same data can flip the sign, so consumers
-- must keep the definition named.
--
-- Two join columns because the two audiences join different catalogs:
-- `world_model_slug` names the entry in the web's vendored PUBLIC simulation
-- catalog (read-only explorer on the signed-out detail page), and
-- `catalog_entry_name` names the wm_catalog_entries row a member imports
-- (add-from-catalog). The door's slug set is canonical; terminal-bench-2's
-- member simulation is the terminal-tasks catalog entry, a mapping that
-- previously hid inside a hardcoded map in the web tier.

create table public.default_models (
  id uuid primary key,
  -- URL identity at /models/<slug>. Same slug grammar as catalog names.
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  title text not null,
  -- The public benchmark the model is built from and measured on.
  benchmark text not null,
  description text not null,
  -- Display pills, e.g. ["tool-calls", "customer-service"].
  tags jsonb not null default '[]'::jsonb check (jsonb_typeof(tags) = 'array'),
  -- Vendored public-catalog simulation slug shown on the signed-out detail
  -- page, or null when no public simulation is published for the benchmark.
  world_model_slug text,
  -- wm_catalog_entries.name the member catalog imports for this default, or
  -- null while the benchmark has no importable catalog entry.
  catalog_entry_name text,
  -- Measured evidence vs the frontier anchor; null = not yet measured.
  headline jsonb check (headline is null or jsonb_typeof(headline) = 'object'),
  -- Gallery order, ascending. Unique so the order is total and deterministic.
  display_order integer not null,
  created_at timestamptz not null default now()
);

comment on table public.default_models is
  'Curation copy for the published default models (the ready endpoints of the default-models workspace org). Service-role only, seeded via seed.sql, read through the FastAPI backend. Numbers derive from endpoint reports, never from this table.';
comment on column public.default_models.headline is
  'RETIRED: always null, never read. Published figures derive from the workspace endpoint''s installed improvement report.';

create unique index default_models_slug_idx on public.default_models (slug);
create unique index default_models_display_order_idx
  on public.default_models (display_order);

-- Service-role only, like the platform's other control-plane tables: RLS on
-- with no policies means anon/authenticated read nothing; the FastAPI
-- backend (service role, bypasses RLS) is the single reader/writer. The
-- public door reaches these rows through the backend, never through
-- PostgREST.
alter table public.default_models enable row level security;
