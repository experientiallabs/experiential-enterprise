-- D-DEFAULTS v1 (decision log 2026-07-29): the central catalog org's endpoints can be
-- flagged as platform defaults, surfaced read-only in every org's Models list instead of
-- cloning a starter endpoint per account. Reads go through the API layer (service role),
-- so no RLS policy changes; the column is inert for existing rows.
alter table public.endpoints
  add column if not exists is_catalog_default boolean not null default false;

-- The list of defaults is read on every org's Models page; without this the read scans
-- the whole table for a handful of flagged rows.
create index if not exists endpoints_catalog_default_idx
  on public.endpoints (created_at desc)
  where is_catalog_default;
