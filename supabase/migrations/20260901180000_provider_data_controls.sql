-- Provider data controls (design E5 item 3): the provider data-posture matrix
-- plus per-org data-control policies (ZDR-only routing, no-training routing,
-- provider allowlists) — the three pricing-page Security claims.
--
-- provider_data_controls holds PLATFORM-CURATED DEFAULTS describing each
-- provider's DEFAULT API data-handling posture, not customer-specific
-- agreements; operators update rows as postures change. A provider absent
-- from this table fails every data-control requirement — fail closed.
--
-- org_provider_policies is the per-org policy the gateway worker enforces at
-- route-filtering time. Enforcement of an existing policy is ALWAYS-ON in the
-- worker (never license-dependent); only the management API that writes rows
-- here is gated on the DATA_CONTROLS /ee capability. Policy visibility rides
-- the worker's catalog watermark (max(updated_at) + row counts over both
-- tables), so every write path must move updated_at — the defaults below and
-- the API's explicit updated_at writes both do.

-- ---------------------------------------------------------------------------
-- 1. The provider posture matrix. One row per provider id as routing knows it
--    (the lowercase provider tokens the catalog and connections carry).

create table public.provider_data_controls (
  provider            pg_catalog.text primary key,
  zero_data_retention pg_catalog.bool not null,
  no_training         pg_catalog.bool not null,
  -- Cite the provider policy the flag is based on.
  source_note         pg_catalog.text not null,
  updated_at          pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

comment on table public.provider_data_controls is
  'Platform-curated defaults describing each provider''s DEFAULT API data-handling posture (design E5 item 3), not customer-specific agreements. Operators update rows as postures change; a provider absent from this table fails every data-control requirement (fail closed).';

-- ---------------------------------------------------------------------------
-- 2. Per-org data-control policy. One row per org; no row means no policy
--    (every provider allowed, no ZDR / no-training requirement).

create table public.org_provider_policies (
  org_id              pg_catalog.uuid primary key
    references public.organizations(id) on delete cascade,
  -- null = all providers allowed.
  allowed_providers   pg_catalog.text[],
  require_zdr         pg_catalog.bool not null default false,
  require_no_training pg_catalog.bool not null default false,
  created_by          pg_catalog.uuid,
  updated_by          pg_catalog.uuid,
  created_at          pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at          pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  -- A non-null allowlist must name at least one provider (an empty allowlist
  -- would silently refuse all traffic — the API refuses it typed, this is the
  -- backstop) and carry only lowercase tokens with no null elements (the
  -- text-cast comparison lowercases every element in one expression).
  -- cardinality, not array_length: array_length of an empty array is NULL,
  -- and a NULL check result would let the empty allowlist through.
  constraint org_provider_policies_allowed_providers_shape check (
    allowed_providers is null
    or (
      pg_catalog.cardinality(allowed_providers) >= 1
      and pg_catalog.array_position(allowed_providers, null) is null
      and allowed_providers::pg_catalog.text
        = pg_catalog.lower(allowed_providers::pg_catalog.text)
    )
  )
);

comment on table public.org_provider_policies is
  'Per-org data-control routing policy (design E5 item 3): provider allowlist plus ZDR / no-training requirements, resolved against provider_data_controls. Management is DATA_CONTROLS-gated; the gateway worker enforces an existing row unconditionally.';

-- ---------------------------------------------------------------------------
-- 3. Curated, conservative seed. Flags describe each provider's DOCUMENTED
--    DEFAULT API posture; when a provider only offers a guarantee by special
--    agreement, the default row says false.

insert into public.provider_data_controls
  (provider, zero_data_retention, no_training, source_note)
values
  ('openai', false, true,
   'OpenAI API data-usage policy: API inputs/outputs retained up to 30 days by default (abuse monitoring); zero-data-retention endpoints exist only by agreement. Not used for training by default.'),
  ('anthropic', false, true,
   'Anthropic commercial terms: limited retention for trust and safety; zero data retention only via enterprise agreement. API inputs/outputs not used for model training.'),
  ('gemini', false, true,
   'Google Gemini API paid-tier terms: prompts/responses not used to improve models; limited abuse-monitoring retention applies, so not zero-data-retention by default.'),
  ('azure_openai', false, true,
   'Azure OpenAI data privacy: prompts/completions stored up to 30 days for abuse monitoring unless modified access is approved; never used to train foundation models.'),
  ('bedrock', true, true,
   'AWS Bedrock data protection: the service does not store prompts/completions (invocation logging is customer opt-in) and does not use them to improve base models.'),
  ('fireworks', false, true,
   'Fireworks AI data policy: API data not used for training; zero data retention is an enterprise-plan option, not the default API posture.'),
  ('openrouter', false, false,
   'OpenRouter is an aggregator: retention and training posture vary by downstream provider and account settings, so neither guarantee can be asserted platform-wide.'),
  ('modal', true, true,
   'Modal-served models run in the customer''s own Modal deployment: requests stay in customer-controlled infrastructure and are not used for training.'),
  ('local', true, true,
   'Customer-run OpenAI-compatible server: data stays in the customer''s own infrastructure, under their retention and training control.');

-- ---------------------------------------------------------------------------
-- 4. Row security and grants: newest-era posture (RLS on, zero policies,
--    revoke-all), like the teams and identity-tier management tables. Only
--    the control API (service_role) reads and writes these; browser roles
--    have no path, and the gateway worker connects as postgres so it needs
--    no grant.

alter table public.provider_data_controls enable row level security;
alter table public.org_provider_policies enable row level security;

revoke all on table public.provider_data_controls
  from public, anon, authenticated, service_role;
revoke all on table public.org_provider_policies
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.provider_data_controls to service_role;
grant select, insert, update, delete on table public.org_provider_policies to service_role;
