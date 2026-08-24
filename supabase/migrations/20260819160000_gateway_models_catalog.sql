-- Gateway models catalog: the single source of truth the AI gateway serves
-- from. Three tables, one concept each:
--
--   models           one row per model concept (public catalog row, or an
--                    org's custom/local model when owning_org_id is set);
--                    `slug` is the public alias customers put in the `model`
--                    field of a gateway request.
--   model_providers  one row per way to reach a model (provider + wire id +
--                    optional org scoping / BYOK pin). The WMO normalizer
--                    turns each row into an ExactModelDeployment.
--   model_waterfalls the ordered fallback chain per model, one row per rung;
--                    a null org_id row set is the default chain, an org's
--                    rows fully replace the default for that org.
--
-- Tenancy model, structural and trigger-enforced (never a management-API
-- promise):
--   * owning_org_id / org_id are assigned at birth and immutable; re-homing
--     a row across tenants is a delete-and-recreate, so referencing rows can
--     trust the org they validated against on insert.
--   * A private model (owning_org_id set) admits only deployments owned by
--     the same org, and only chains belonging to that org (its default chain
--     or its own override).
--   * A chain's effective tenant is coalesce(chain org, model org); every
--     rung's deployment must be public or owned by that tenant, so no chain
--     can route any other tenant's traffic through a private endpoint or
--     credential.
--   * A BYOK pin must belong to the deployment's owning org (public
--     deployments cannot pin org credentials) and match the deployment's
--     provider.
--
-- Locked down like `endpoints`: RLS enabled, grants revoked from browser
-- roles. All reads and writes go through the service role behind the
-- management API; public catalog browsing happens via the API, not direct
-- table access.

create table public.models (
  id uuid primary key default gen_random_uuid(),
  -- URL-safe public alias (e.g. claude-opus-5, glm-5.3), leading with a
  -- lowercase letter: the slug becomes the gateway alias, which WMO types as
  -- ArtifactId with a letter-first pattern, so a digit-first slug would be a
  -- catalog row that can never be called. Uniqueness is per owning namespace
  -- (see models_namespace_slug_key below): the public catalog is one
  -- namespace, each owning org another, so an org's custom model may reuse
  -- a public slug without colliding.
  slug text not null check (slug ~ '^[a-z][a-z0-9._-]{0,127}$'),
  display_name text not null,
  description text,
  release_date date,
  context_window integer check (context_window > 0),
  max_output_tokens integer check (max_output_tokens > 0),
  input_modalities text[] not null default '{text}',
  output_modalities text[] not null default '{text}',
  -- Both modality lists draw from one vocabulary and are never empty; <@
  -- also rejects null elements (a null is contained in nothing).
  constraint models_modalities_check check (
    cardinality(input_modalities) > 0
    and input_modalities <@ array['text', 'image', 'audio', 'video', 'pdf']
    and array_position(input_modalities, null) is null
    and cardinality(output_modalities) > 0
    and output_modalities <@ array['text', 'image', 'audio', 'video', 'pdf']
    and array_position(output_modalities, null) is null
  ),
  -- Boolean map: tools, temperature, reasoning, top_p, response_format,
  -- structured_outputs, stop, seed, logprobs, ...
  supported_params jsonb not null default '{}'::jsonb
    check (jsonb_typeof(supported_params) = 'object'),
  -- Free-form specialized category: coding, reasoning, vision, embedding, ...
  category text,
  tags text[] not null default '{}',
  -- Null = public catalog; set = that org's custom/local model, visible and
  -- callable only for the org. Immutable (models_guard_tenancy).
  owning_org_id uuid references public.organizations(id) on delete cascade,
  -- Non-null = pinned at the top of the catalog, ascending.
  preferred_rank integer,
  status text not null default 'active' check (status in ('active', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The public catalog (null owning_org_id) and each org are separate slug
  -- namespaces; nulls-not-distinct makes public rows collide with each
  -- other. Leading with slug, the backing index also serves slug lookups.
  constraint models_namespace_slug_key
    unique nulls not distinct (slug, owning_org_id)
);

create index models_preferred_rank_idx on public.models (preferred_rank)
  where preferred_rank is not null;

-- Serves the organizations -> models delete cascade; the namespace key leads
-- with slug, so it cannot.
create index models_owning_org_idx on public.models (owning_org_id)
  where owning_org_id is not null;

-- FK target for the BYOK pin below: referencing (id, org_id) together makes
-- an org-mismatched pin a foreign-key violation instead of an API promise.
create unique index provider_connections_id_org_key
  on public.provider_connections (id, org_id);

create table public.model_providers (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.models(id) on delete cascade,
  -- The provider vocabulary lives in three independent check constraints
  -- that must be widened in lockstep (a shared domain type is the
  -- post-launch cleanup):
  --   * provider_connections_provider_check (BYOK; no local by design:
  --     local is customer infrastructure with no stored credential, and no
  --     fireworks/modal until the keys workstream admits them)
  --   * optimizer_project_setup_models_provider_check (Project setup)
  --   * this constraint, the only one admitting fireworks and modal
  -- fireworks and modal execute through the openai-compatible provider
  -- family in the WMO catalog builder, so no row here is structurally
  -- unroutable.
  provider text not null check (
    provider in (
      'openai', 'anthropic', 'gemini', 'azure_openai', 'openrouter',
      'bedrock', 'local', 'fireworks', 'modal'
    )
  ),
  -- The exact model id on the provider's wire.
  provider_model_id text not null,
  -- Per-deployment OpenAI-compatible endpoint. Required for local
  -- (self-hosted) and modal (org-deployed endpoints behind Modal auth);
  -- forbidden for every other provider, which addresses a fixed origin
  -- (fireworks included) — and since base_url joins the identity key, a
  -- stray value on a hosted row would mint a duplicate route identity.
  base_url text,
  constraint model_providers_base_url_check check (
    case when provider in ('local', 'modal')
      -- The leading is-not-null keeps the CASE from yielding null (which a
      -- CHECK would pass) when the row omits its base_url. The value must
      -- match an explicit endpoint grammar rather than "anything after the
      -- scheme": lowercase http(s) scheme, a host (name/IPv4, or a CLOSED
      -- bracketed IPv6 literal), an optional port in 1..65535, an optional
      -- path. Userinfo, query, and fragment are forbidden outright: they
      -- are meaningless in an OpenAI-compatible base URL and only surface
      -- as failures at request time. Plain http:// stays legal on purpose:
      -- cluster-internal serving URLs (the legacy fold, org GPU proxies)
      -- terminate TLS at the ingress.
      then base_url is not null
        and base_url ~ '^https?://([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[A-Za-z0-9._~%/-]*)?$'
        and char_length(base_url) <= 2048
      else base_url is null
    end
  ),
  region text,
  api_version text,
  -- Null = available to all; set = an org's private deployment (e.g. a
  -- local variant added from the model detail page). Immutable
  -- (model_providers_guard_tenancy).
  owning_org_id uuid references public.organizations(id) on delete cascade,
  -- Pin this deployment to a specific BYOK connection; null resolves by
  -- org + provider at request time. The composite FK below proves the
  -- pinned connection belongs to the deployment's owning org, which
  -- therefore must exist (public deployments cannot borrow org
  -- credentials). Losing the connection clears only the pin: the
  -- deployment degrades to request-time resolution instead of dropping.
  provider_connection_id uuid,
  constraint model_providers_pin_requires_org check (
    provider_connection_id is null or owning_org_id is not null
  ),
  constraint model_providers_connection_pin_fk
    foreign key (provider_connection_id, owning_org_id)
    references public.provider_connections (id, org_id)
    on delete set null (provider_connection_id),
  billing_source text not null default 'customer_managed' check (
    billing_source in ('customer_managed', 'host_managed')
  ),
  -- Integer micro-USD per million tokens. Null means unknown and must never
  -- be read as zero. Column -> GatewayTokenPrices field, mapped explicitly
  -- by the normalizer (the contract's field names carry a _tokens suffix
  -- these columns drop, so no name-convention serializer may zip them):
  --   input_micro_usd_per_million        -> input_micro_usd_per_million_tokens
  --   cached_input_micro_usd_per_million -> cached_input_micro_usd_per_million_tokens
  --   output_micro_usd_per_million       -> output_micro_usd_per_million_tokens
  --   reasoning_micro_usd_per_million    -> reasoning_micro_usd_per_million_tokens
  input_micro_usd_per_million bigint,
  cached_input_micro_usd_per_million bigint,
  output_micro_usd_per_million bigint,
  reasoning_micro_usd_per_million bigint,
  constraint model_providers_prices_nonnegative check (
    input_micro_usd_per_million >= 0
    and cached_input_micro_usd_per_million >= 0
    and output_micro_usd_per_million >= 0
    and reasoning_micro_usd_per_million >= 0
  ),
  pricing_source text,
  pricing_effective_at timestamptz,
  -- Mirrors WMO ModelCapabilities / GatewayDeploymentCapabilities booleans,
  -- including reports_cached_input_tokens and reports_reasoning_tokens.
  capabilities jsonb not null default '{}'::jsonb
    check (jsonb_typeof(capabilities) = 'object'),
  -- Catalog UI stats; tracked from day one, displayed per product decision.
  uptime_30d numeric,
  throughput_tps numeric,
  latency_p50_ms numeric,
  stats_source text check (stats_source in ('openrouter', 'observed')),
  status text not null default 'active' check (
    status in ('active', 'degraded', 'disabled')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per distinct route: base_url joins the identity so two local
  -- variants of one wire id addressing different servers stay two rows;
  -- nulls-not-distinct makes null org / null base_url rows collide. Leading
  -- with model_id, the backing index also serves the model_id lookups the
  -- catalog reads need.
  constraint model_providers_identity_key unique nulls not distinct (
    model_id, provider, provider_model_id, owning_org_id, base_url
  )
);

-- FK target for model_waterfalls: lets a rung reference (model_id, id)
-- together, so pointing a chain at another model's deployment is
-- structurally impossible rather than a management-API promise.
create unique index model_providers_model_route_key
  on public.model_providers (model_id, id);

-- Serve the organizations cascade and the pin's set-null lookup; neither
-- column leads an existing index.
create index model_providers_owning_org_idx
  on public.model_providers (owning_org_id)
  where owning_org_id is not null;
create index model_providers_connection_pin_idx
  on public.model_providers (provider_connection_id)
  where provider_connection_id is not null;

create table public.model_waterfalls (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.models(id) on delete cascade,
  -- Null = the default chain; set = that org's override, which fully
  -- replaces the default for that org.
  org_id uuid references public.organizations(id) on delete cascade,
  -- 0 = primary. The position ordering IS the waterfall order; the WMO
  -- normalizer must preserve it into ExactModelPool.deployment_ids.
  position integer not null check (position >= 0),
  model_provider_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The composite reference carries model_id so a rung can only name a
  -- deployment of its own model; the cascade removes rungs with their
  -- deployment.
  constraint model_waterfalls_model_provider_fk
    foreign key (model_id, model_provider_id)
    references public.model_providers (model_id, id) on delete cascade,
  -- One rung per position per chain (null org_id = the default chain,
  -- colliding via nulls-not-distinct). The backing index is also the
  -- chain-resolution read path: (model_id, org_id, position).
  constraint model_waterfalls_chain_position_key
    unique nulls not distinct (model_id, org_id, position),
  -- A deployment appears at most once per chain.
  constraint model_waterfalls_chain_deployment_key
    unique nulls not distinct (model_id, org_id, model_provider_id)
);

-- Serves the organizations -> model_waterfalls delete cascade; org_id does
-- not lead either unique.
create index model_waterfalls_org_idx on public.model_waterfalls (org_id)
  where org_id is not null;

-- Service-role only, same posture as endpoints: no policies, no browser
-- grants. The management API is the sole read/write path.
alter table public.models enable row level security;
alter table public.model_providers enable row level security;
alter table public.model_waterfalls enable row level security;
revoke all on table public.models from public, anon, authenticated;
revoke all on table public.model_providers from public, anon, authenticated;
revoke all on table public.model_waterfalls from public, anon, authenticated;

-- Management-API writes are plain service-role DML (no per-table RPCs), so
-- the shared trigger keeps updated_at honest.
create trigger models_set_updated_at
before update on public.models
for each row execute function public.set_updated_at();

create trigger model_providers_set_updated_at
before update on public.model_providers
for each row execute function public.set_updated_at();

create trigger model_waterfalls_set_updated_at
before update on public.model_waterfalls
for each row execute function public.set_updated_at();

-- Tenancy guards. Plain FKs cannot express "public OR the chain's tenant",
-- so the disjunctions live in row triggers; the immutability rules above
-- make the reads race-free (what a rung validated against on insert cannot
-- change out from under it, only disappear via the delete cascades).

create function public.models_guard_tenancy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owning_org_id is distinct from old.owning_org_id then
    raise exception using
      errcode = '23514',
      message = 'models.owning_org_id is immutable; re-home a model by delete and recreate';
  end if;
  return new;
end;
$$;

create trigger models_guard_tenancy
before update on public.models
for each row execute function public.models_guard_tenancy();

create function public.model_providers_guard_tenancy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  model_org uuid;
  pinned_provider text;
begin
  if tg_op = 'UPDATE' and new.owning_org_id is distinct from old.owning_org_id then
    raise exception using
      errcode = '23514',
      message = 'model_providers.owning_org_id is immutable; re-home a deployment by delete and recreate';
  end if;

  select models.owning_org_id into model_org
  from public.models
  where models.id = new.model_id;

  -- A private model admits only its owner's deployments: a null (public)
  -- deployment on a private model would leak it into every tenant's
  -- resolution, and another org's deployment would route the owner's
  -- traffic through foreign infrastructure.
  if model_org is not null and new.owning_org_id is distinct from model_org then
    raise exception using
      errcode = '23514',
      message = 'a deployment on a private model must be owned by the model''s org';
  end if;

  -- The composite FK proves the pinned connection's org; the provider match
  -- is not expressible there, so it lives here.
  if new.provider_connection_id is not null then
    select connections.provider into pinned_provider
    from public.provider_connections connections
    where connections.id = new.provider_connection_id;
    if pinned_provider is distinct from new.provider then
      raise exception using
        errcode = '23514',
        message = 'a pinned provider connection must match the deployment''s provider';
    end if;
  end if;

  return new;
end;
$$;

create trigger model_providers_guard_tenancy
before insert or update on public.model_providers
for each row execute function public.model_providers_guard_tenancy();

create function public.model_waterfalls_guard_tenancy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  model_org uuid;
  deployment_org uuid;
  effective_tenant uuid;
begin
  select models.owning_org_id into model_org
  from public.models
  where models.id = new.model_id;

  -- Chains on a private model belong to its owner: the default chain (null
  -- org_id) is the model's own, and only the owning org may override it.
  if model_org is not null and new.org_id is not null and new.org_id <> model_org then
    raise exception using
      errcode = '23514',
      message = 'a waterfall chain on a private model belongs to the model''s owning org';
  end if;

  -- The chain's effective tenant: an override serves its org; a default
  -- chain serves everyone for a public model and the owner for a private
  -- one. Every rung must be public or owned by that tenant, so no chain can
  -- route another tenant's traffic through a private endpoint or credential.
  effective_tenant := coalesce(new.org_id, model_org);

  select deployments.owning_org_id into deployment_org
  from public.model_providers deployments
  where deployments.id = new.model_provider_id;

  if deployment_org is not null
    and (effective_tenant is null or deployment_org <> effective_tenant) then
    raise exception using
      errcode = '23514',
      message = 'a waterfall rung may reference only public deployments or the chain tenant''s own';
  end if;

  return new;
end;
$$;

create trigger model_waterfalls_guard_tenancy
before insert or update on public.model_waterfalls
for each row execute function public.model_waterfalls_guard_tenancy();

-- Lockstep markers on the sibling provider vocabularies (see the provider
-- check comment above).
comment on constraint provider_connections_provider_check
  on public.provider_connections is
  'Provider vocabulary duplicated in model_providers_provider_check and optimizer_project_setup_models_provider_check; widen in lockstep.';
comment on constraint optimizer_project_setup_models_provider_check
  on public.optimizer_project_setup_models is
  'Provider vocabulary duplicated in model_providers_provider_check and provider_connections_provider_check; widen in lockstep.';
