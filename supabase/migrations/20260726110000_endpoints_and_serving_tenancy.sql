-- Endpoints: the hosted-serving product object (world model + learned inference
-- policy + eval evidence + serving URL; the UI labels it a "model"). One row per
-- org-scoped endpoint; `name` is the slug the customer's OpenAI client sends as
-- `model` and the /models/{slug} page routes on.
--
-- Also adds the api_key_id tenancy column D-METERING promised on
-- serving_requests. The serving spend trigger + recompute term moved to
-- 20260726100000_serving_usage_rollup (PR #365), which owns the usage-page
-- fold they keep honest; this file is stamped after it so `supabase db push`
-- applies in order regardless of which PR merged first.

create table public.endpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- The world model this endpoint was created from. Kept when the world model
  -- is deleted: the endpoint still serves (the policy is self-contained), it
  -- only loses scenario-derived surfaces like playground suggestions.
  world_model_id uuid references public.world_models(id) on delete set null,
  -- Same slug rule as world_models.name, so the two namespaces feel like one
  -- product (the create modal enforces the same pattern client-side).
  name text not null check (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  -- Pipeline stage mirror of the frontend EndpointStatus union. An endpoint
  -- created from an already-built world model is born ready; the earlier
  -- stages are written by the live pipeline (onboarding-ui workstream).
  status text not null default 'ready'
    check (status in ('ingesting', 'building', 'optimizing', 'ready', 'failed')),
  -- wmh RoutingPolicy dump (model_dump mode="json"). Server-internal: the pool
  -- snapshot carries provider runtime ids and deployment names, so API views
  -- expose only a derived policy summary, never this column.
  policy jsonb not null,
  -- wmh ImprovementReport dump; null until an optimizer run produces evidence.
  report jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create index endpoints_org_created_idx
  on public.endpoints (org_id, created_at desc);

-- Locked down like serving_requests: reads go through the explabs service
-- role, which strips the policy internals. A direct table SELECT would expose
-- provider deployment ids the platform treats as server-internal.
alter table public.endpoints enable row level security;
revoke all on table public.endpoints from public, anon, authenticated;

-- D-METERING tenancy: which org API key made the serving call (null for
-- playground traffic, which is session-authed through the web app). Stored for
-- attribution; no serving read RPC returns it.
alter table public.serving_requests
  add column api_key_id uuid references public.api_keys(id) on delete set null;

comment on column public.serving_requests.api_key_id is
  'Org API key that authenticated the call; null for platform-internal traffic (playground). Attribution only, never served by read RPCs.';
