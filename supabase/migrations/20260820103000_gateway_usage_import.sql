-- Historical usage import: the onboarding "bootstrap your dashboard with your
-- real AI spend" lane. A founder's agent parses their LOCAL Codex and Claude
-- Code session logs (METADATA ONLY — model + per-turn token counts, never any
-- message content) and POSTs aggregated per-turn usage to
-- /api/gateway/usage/import. Those records land here, NOT in
-- gateway_usage_events.
--
-- Why a table SEPARATE from gateway_usage_events (schema-owner ruling):
--   * gateway_usage_events.request_id is a primary key that REFERENCES
--     gateway_requests(request_id): every event belongs to a real gateway
--     request this platform served. Imported turns have no such request, so
--     they cannot live there without fabricating request rows or dropping the
--     foreign key that anchors settled-money history.
--   * gateway_usage_events is append-only settled money the credit ledger
--     reconciles against; billing/telemetry/analytics read it as THE charged
--     stream. Imported spend is HISTORICAL ATTRIBUTION only — never charged,
--     never drawn from credits, and CORRECTABLE (a re-import may fix a model
--     mapping), which the append-only trigger forbids. A separate table keeps
--     the charged-money invariant impossible to violate by omission.
--
-- Money vocabulary matches gateway_usage_events' charged/estimated split: this
-- table has ONLY estimated_cost_micro_usd (integer micro-USD, list-price
-- estimate at import time) and no cost_micro_usd, because nothing here is ever
-- charged. The read path merges this, labeled historical/estimated, alongside
-- gateway usage for the Telemetry "Imported" view; it never enters charged
-- totals or credit math.

create table public.gateway_imported_usage_events (
  -- Owning organization (the account being bootstrapped).
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  -- Stable sha256 (hex) the import endpoint computes over each turn's identity
  -- (source, the log's native turn id, raw model, timestamp, token counts).
  -- With org_id it is the IDENTITY of an imported turn: dedupe is
  -- (org_id, record_hash), NOT batch-scoped, so a retry under a new batch_id or
  -- two overlapping export files cannot double-count the same turn.
  record_hash pg_catalog.text not null
    check (record_hash ~ '^[0-9a-f]{64}$'),
  -- The member who ran the import (attribution). Null when unknown (an
  -- organization-key import has no end user); per-user reads bucket null as the
  -- zero uuid, matching gateway_usage_daily.
  user_id pg_catalog.uuid,
  -- Provenance of the import run that LAST wrote this row (a re-import
  -- overwrites it in place; not identity).
  batch_id pg_catalog.text not null
    check (pg_catalog.char_length(batch_id) between 1 and 200),
  -- Origin tool the metadata came from.
  import_source pg_catalog.text not null
    check (import_source in ('codex', 'claude-code')),
  -- The model string exactly as it appeared in the local log.
  model_raw pg_catalog.text not null,
  -- The launch-catalog model slug model_raw mapped to; null when it matched
  -- nothing in the catalog (then model_matched is false and
  -- estimated_cost_micro_usd is 0 — recorded, never guessed).
  alias pg_catalog.text,
  -- The mapped model's catalog provider; null when unmatched.
  provider pg_catalog.text,
  -- Whether model_raw resolved to a catalog model. Unmatched rows still count
  -- tokens; they just carry no attributed cost.
  model_matched pg_catalog.bool not null,
  -- Fresh (non-cached) input tokens, priced at the input rate.
  input_tokens pg_catalog.int8 not null default 0 check (input_tokens >= 0),
  -- Output tokens (reasoning included, as the providers bill them).
  output_tokens pg_catalog.int8 not null default 0 check (output_tokens >= 0),
  -- Cached input tokens, priced at the cheaper cached-input rate.
  cached_input_tokens pg_catalog.int8 not null default 0
    check (cached_input_tokens >= 0),
  -- Reasoning tokens, carried for display only (already inside output_tokens).
  reasoning_tokens pg_catalog.int8 not null default 0
    check (reasoning_tokens >= 0),
  -- ESTIMATED (never charged) attribution spend, integer micro-USD, from the
  -- launch catalog list price at import time. Never enters credit math. Zero
  -- for unmatched models. Named to match gateway_usage_events'
  -- estimated_cost_micro_usd so the same three teams read one vocabulary.
  estimated_cost_micro_usd pg_catalog.int8 not null default 0
    check (estimated_cost_micro_usd >= 0),
  -- The turn's own timestamp, from the local log (UTC).
  occurred_at pg_catalog.timestamptz not null,
  -- UTC date of occurred_at; the per-day bucket key for range reads. Pinned to
  -- occurred_at so a buggy caller can never mis-bucket a day.
  day pg_catalog.date not null
    check (day = (occurred_at at time zone 'UTC')::pg_catalog.date),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (org_id, record_hash)
);

-- The spend view filters an org over DAY RANGES; this serves those directly
-- (no daily rollup table: a single org's import is bounded by its own local
-- history, and keeping imports in one correctable table avoids a rollup that
-- could drift when a re-import fixes a mapping).
create index gateway_imported_usage_events_org_day_idx
  on public.gateway_imported_usage_events (org_id, day desc);
-- Per-(source, model) rollups for the "Imported" breakdown.
create index gateway_imported_usage_events_org_model_idx
  on public.gateway_imported_usage_events (org_id, import_source, alias);

comment on table public.gateway_imported_usage_events is
  'Historical AI-spend attribution imported from a tenant''s LOCAL Codex/Claude Code logs (metadata only). estimated_cost_micro_usd only: never charged, never reconciled against credits, deliberately separate from gateway_usage_events (gateway-served money). Identity is (org_id, record_hash); a re-import overwrites a turn''s mapping in place (correctable), never double-counting.';

-- A re-import corrects a turn in place; keep updated_at honest on every
-- ON CONFLICT DO UPDATE so the last-write time is observable.
create function public.gateway_imported_usage_touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

revoke all on function public.gateway_imported_usage_touch_updated_at()
  from public, anon, authenticated, service_role;

create trigger gateway_imported_usage_events_touch_updated_at
before update on public.gateway_imported_usage_events
for each row execute function public.gateway_imported_usage_touch_updated_at();

-- Service-role reads and writes only. This stack's migrate bootstrap sets
-- ALTER DEFAULT PRIVILEGES granting ALL to service_role and SELECT to
-- anon/authenticated on new public tables, so revoke first (house style on
-- every gateway table), then grant exactly what the import path uses. RLS is on
-- with no policy, so anon/authenticated see no rows and the service role
-- bypasses RLS. UPDATE is granted so a re-import can correct a turn's model
-- mapping in place (ON CONFLICT (org_id, record_hash) DO UPDATE) — the
-- deliberate correctability that keeps imports OUT of the append-only money
-- table. No cross-table invariant sits behind a single write, so the write
-- path stays a service-role upsert (same carve-out as gateway_key_limits)
-- rather than a definer function.
alter table public.gateway_imported_usage_events enable row level security;
revoke all on table public.gateway_imported_usage_events
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.gateway_imported_usage_events to service_role;
