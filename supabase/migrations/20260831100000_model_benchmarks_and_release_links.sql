-- Model benchmarks + release links: the first real quality signal attached to
-- the public catalog.
--
--   model_benchmarks   one row per (model, benchmark) measurement, keyed on
--                      models.id. Keying on the uuid, never the slug, is
--                      deliberate: dedup migrations rename slugs in place
--                      while preserving ids (see
--                      20260828280000_reconcile_alias_identities_with_dedup —
--                      slug-pinned identity drifted 131 rows and broke every
--                      production catalog refresh).
--   models gains two nullable links: huggingface_url (the open-weights HF
--   repo) and release_url (the vendor's official release/announcement page,
--   used when no HF repo exists — closed-weights models).
--
-- Provenance follows the constrained stats_source pattern
-- (20260828240000_model_stats_source_estimate), not free-text pricing_source:
-- `source` names where the number came from and is widened additively when a
-- new source class is admitted. Attribution requirements ride on it (LMArena
-- leaderboard data is CC-BY-4.0; vendor numbers are cited via source_url).
-- Artificial Analysis is deliberately absent: its free/pro API tiers are
-- internal-use-only and forbid redistribution in customer-facing products.
--
-- No score column lands on models itself: default_models.headline
-- (20260730120000) is the documented precedent against denormalizing a
-- quality figure onto a catalog row — store the measurement once, derive
-- display numbers. Per-benchmark display metadata (unit, display name,
-- higher-is-better) deliberately lives in a code registry shipped with the
-- ingestion lane, not in the database: the check below pins only the format
-- of the key, the registry pins its meaning.

create table public.model_benchmarks (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.models(id) on delete cascade,
  -- Benchmark key (e.g. mmlu-pro, gpqa-diamond, swe-bench-verified,
  -- lmarena-text-elo). Same shape rules as models.slug so keys stay
  -- URL-safe for the compare surface.
  benchmark text not null check (benchmark ~ '^[a-z][a-z0-9._-]{0,63}$'),
  -- Raw published figure in the benchmark's native unit (percent for most
  -- evals, rating for arena Elo). The code registry, not the database,
  -- knows the unit; scores are never rescaled at rest.
  score numeric not null check (score >= 0),
  -- Where the number was read from, constrained like stats_source and
  -- widened additively:
  --   vendor       the maker's model card, blog post, or system card
  --   huggingface  an HF model page or HF-hosted leaderboard
  --   lmarena      the LMArena leaderboard dataset (CC-BY-4.0, attributed)
  --   leaderboard  another public leaderboard (LiveBench, SWE-bench, ...)
  --   paper        a published paper or technical report
  source text not null check (
    source in ('vendor', 'huggingface', 'lmarena', 'leaderboard', 'paper')
  ),
  -- Exact citation for the score, when one exists: https with a real dotted
  -- host whose labels start and end alphanumeric, so a bare scheme or a
  -- malformed host (..com, -vendor.com) can never persist as a citation.
  source_url text check (
    source_url is null
    or source_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(/[^[:space:]]*)?$'
  ),
  -- When the source was read; re-ingestion refreshes it.
  retrieved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One current score per benchmark per model; the ingestion lane upserts,
  -- so a re-run replaces rather than accumulates.
  constraint model_benchmarks_model_benchmark_key unique (model_id, benchmark)
);

-- No separate model_id index: the unique key above leads with model_id, so
-- its backing index already serves both the per-model read path and the
-- models -> model_benchmarks delete cascade.

-- Service-role only, same posture as the rest of the catalog: no policies,
-- no browser grants. Public browsing happens via the API.
alter table public.model_benchmarks enable row level security;
revoke all on table public.model_benchmarks from public, anon, authenticated;

create trigger model_benchmarks_set_updated_at
before update on public.model_benchmarks
for each row execute function public.set_updated_at();

-- Release links on the catalog row itself: these are identity metadata (one
-- per model), not measurements, so they live on models.
alter table public.models
  add column huggingface_url text check (
    huggingface_url is null
    or huggingface_url ~ '^https://huggingface\.co/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  add column release_url text check (
    release_url is null
    or release_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(/[^[:space:]]*)?$'
  );

comment on column public.models.huggingface_url is
  'Hugging Face repo for open-weights models; null when weights are closed.';
comment on column public.models.release_url is
  'The vendor''s official release or announcement page; the display fallback '
  'when no Hugging Face repo exists.';
