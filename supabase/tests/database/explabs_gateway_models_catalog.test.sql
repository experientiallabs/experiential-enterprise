begin;

create extension if not exists pgtap with schema extensions;

select plan(72);

-- Table shapes.

select has_table('public', 'models', 'the models catalog table exists');
select has_table('public', 'model_providers', 'the model_providers table exists');
select has_table('public', 'model_waterfalls', 'the model_waterfalls table exists');

select columns_are(
  'public',
  'models',
  array[
    'id',
    'slug',
    'display_name',
    'description',
    'release_date',
    'context_window',
    'max_output_tokens',
    'input_modalities',
    'output_modalities',
    'supported_params',
    'category',
    'tags',
    'icon',
    'owning_org_id',
    'preferred_rank',
    'status',
    'created_at',
    'updated_at',
    'huggingface_url',
    'release_url'
  ],
  'models carries exactly the core-P1 catalog columns plus release links'
);

select columns_are(
  'public',
  'model_providers',
  array[
    'id',
    'model_id',
    'provider',
    'provider_model_id',
    'base_url',
    'region',
    'api_version',
    'owning_org_id',
    'provider_connection_id',
    'billing_source',
    'input_micro_usd_per_million',
    'cached_input_micro_usd_per_million',
    'output_micro_usd_per_million',
    'reasoning_micro_usd_per_million',
    'pricing_source',
    'pricing_effective_at',
    'capabilities',
    'uptime_30d',
    'throughput_tps',
    'latency_p50_ms',
    'stats_source',
    'status',
    'created_at',
    'updated_at'
  ],
  'model_providers carries exactly the core-P1 deployment columns'
);

select columns_are(
  'public',
  'model_waterfalls',
  array[
    'id',
    'model_id',
    'org_id',
    'position',
    'model_provider_id',
    'created_at',
    'updated_at'
  ],
  'model_waterfalls carries exactly the core-P1 rung columns'
);

select is(
  (
    select data_type from information_schema.columns
    where table_schema = 'public'
      and table_name = 'model_providers'
      and column_name = 'input_micro_usd_per_million'
  ),
  'bigint',
  'prices are bigint micro-USD per million tokens matching GatewayTokenPrices'
);

-- RLS posture: service-role only, no policies, browser roles fully revoked.

select ok(
  (select relrowsecurity from pg_class where oid = 'public.models'::regclass),
  'models has row level security enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.model_providers'::regclass),
  'model_providers has row level security enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.model_waterfalls'::regclass),
  'model_waterfalls has row level security enabled'
);

select is(
  (
    select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('models', 'model_providers', 'model_waterfalls')
  ),
  0,
  'no policies exist: every read and write goes through the service role'
);

select table_privs_are(
  'public', 'models', 'authenticated', '{}'::text[],
  'authenticated holds no grants on models'
);
select table_privs_are(
  'public', 'model_providers', 'authenticated', '{}'::text[],
  'authenticated holds no grants on model_providers'
);
select table_privs_are(
  'public', 'model_waterfalls', 'authenticated', '{}'::text[],
  'authenticated holds no grants on model_waterfalls'
);

-- The load-bearing chain-resolution index: the position unique doubles as
-- the (model_id, org_id, position) read path. Uniqueness semantics are
-- proven behaviorally below; only this index is name-pinned.

select has_index(
  'public', 'model_waterfalls', 'model_waterfalls_chain_position_key',
  'model_waterfalls has the chain-resolution index'
);

-- updated_at maintenance.

select has_trigger(
  'public', 'models', 'models_set_updated_at',
  'models maintains updated_at'
);
select has_trigger(
  'public', 'model_providers', 'model_providers_set_updated_at',
  'model_providers maintains updated_at'
);
select has_trigger(
  'public', 'model_waterfalls', 'model_waterfalls_set_updated_at',
  'model_waterfalls maintains updated_at'
);

-- Checks and uniques, behaviorally.

insert into public.organizations (id, slug, name)
values
  ('b6000000-0000-0000-0000-000000000001', 'catalog-org-a', 'Catalog Org A'),
  ('b6000000-0000-0000-0000-000000000002', 'catalog-org-b', 'Catalog Org B');

insert into public.models (id, slug, display_name)
values (
  'b6000000-0000-0000-0000-000000000010',
  'claude-opus-5',
  'Claude Opus 5'
);

select throws_ok(
  $$
  insert into public.models (slug, display_name)
  values ('claude-opus-5', 'Duplicate Public Row')
  $$,
  '23505',
  null,
  'the public catalog holds one row per slug'
);

select lives_ok(
  $$
  insert into public.models (id, slug, display_name, owning_org_id)
  values (
    'b6000000-0000-0000-0000-000000000011',
    'claude-opus-5',
    'Org A Custom Variant',
    'b6000000-0000-0000-0000-000000000001'
  )
  $$,
  'an org-owned model may reuse a public slug in its own namespace'
);

select throws_ok(
  $$
  insert into public.models (slug, display_name, owning_org_id)
  values (
    'claude-opus-5',
    'Org A Duplicate',
    'b6000000-0000-0000-0000-000000000001'
  )
  $$,
  '23505',
  null,
  'one org cannot duplicate a slug inside its own namespace'
);

select throws_ok(
  $$
  insert into public.models (slug, display_name)
  values ('Not A Slug!', 'Bad Slug')
  $$,
  '23514',
  null,
  'model slugs are URL-safe at the database boundary'
);

select throws_ok(
  $$
  insert into public.models (slug, display_name)
  values ('4o-mini', 'Digit-First Slug')
  $$,
  '23514',
  null,
  'slugs lead with a letter: a digit-first slug could never become a callable gateway alias (ArtifactId)'
);

select throws_ok(
  $$
  insert into public.models (slug, display_name, status)
  values ('status-check', 'Status Check', 'retired')
  $$,
  '23514',
  null,
  'model status admits only active and hidden'
);

insert into public.model_providers (
  id, model_id, provider, provider_model_id,
  input_micro_usd_per_million, output_micro_usd_per_million
)
values
  (
    'b6000000-0000-0000-0000-000000000020',
    'b6000000-0000-0000-0000-000000000010',
    'anthropic',
    'claude-opus-5',
    15000000,
    75000000
  ),
  (
    'b6000000-0000-0000-0000-000000000021',
    'b6000000-0000-0000-0000-000000000010',
    'bedrock',
    'us.anthropic.claude-opus-5-v1:0',
    null,
    null
  ),
  (
    'b6000000-0000-0000-0000-000000000022',
    'b6000000-0000-0000-0000-000000000010',
    'openrouter',
    'anthropic/claude-opus-5',
    null,
    null
  );

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'sagemaker',
    'claude-opus-5'
  )
  $$,
  '23514',
  null,
  'provider admits exactly the nine launch providers'
);

select throws_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, billing_source
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'openai',
    'gpt-5.5',
    'sponsored'
  )
  $$,
  '23514',
  null,
  'billing_source admits only customer_managed and host_managed'
);

select throws_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, input_micro_usd_per_million
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'openai',
    'gpt-5.5',
    -1
  )
  $$,
  '23514',
  null,
  'prices are non-negative; unknown is null, never a sentinel'
);

select throws_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, stats_source
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'openai',
    'gpt-5.5',
    'vibes'
  )
  $$,
  '23514',
  null,
  'stats_source admits only openrouter and observed'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf'
  )
  $$,
  '23514',
  null,
  'a local deployment requires its base_url'
);

select lives_ok(
  $$
  insert into public.model_providers (
    id, model_id, provider, provider_model_id, base_url, owning_org_id
  )
  values (
    'b6000000-0000-0000-0000-000000000023',
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'https://inference.org-a.internal/v1',
    'b6000000-0000-0000-0000-000000000001'
  )
  $$,
  'a local variant with a base_url is an ordinary deployment row'
);

select lives_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, base_url, owning_org_id
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'https://inference-2.org-a.internal/v1',
    'b6000000-0000-0000-0000-000000000001'
  )
  $$,
  'one wire id at two base_urls stays two distinct routes'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'anthropic',
    'claude-opus-5'
  )
  $$,
  '23505',
  null,
  'one route (model, provider, wire id, org, base_url) is one row'
);

-- Waterfall ordering round-trip: rungs inserted out of order resolve in
-- position order, and an org override replaces the default independently.

insert into public.model_waterfalls (model_id, position, model_provider_id)
values
  (
    'b6000000-0000-0000-0000-000000000010',
    2,
    'b6000000-0000-0000-0000-000000000022'
  ),
  (
    'b6000000-0000-0000-0000-000000000010',
    0,
    'b6000000-0000-0000-0000-000000000020'
  ),
  (
    'b6000000-0000-0000-0000-000000000010',
    1,
    'b6000000-0000-0000-0000-000000000021'
  );

select is(
  (
    select array_agg(providers.provider order by rungs.position)
    from public.model_waterfalls rungs
    join public.model_providers providers
      on providers.id = rungs.model_provider_id
    where rungs.model_id = 'b6000000-0000-0000-0000-000000000010'
      and rungs.org_id is null
  ),
  array['anthropic', 'bedrock', 'openrouter'],
  'the default chain round-trips in position order regardless of insert order'
);

select throws_ok(
  $$
  insert into public.model_waterfalls (model_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    0,
    'b6000000-0000-0000-0000-000000000022'
  )
  $$,
  '23505',
  null,
  'one chain cannot hold two rungs at one position'
);

select throws_ok(
  $$
  insert into public.model_waterfalls (model_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    3,
    'b6000000-0000-0000-0000-000000000020'
  )
  $$,
  '23505',
  null,
  'one chain cannot hold the same deployment twice'
);

select throws_ok(
  $$
  insert into public.model_waterfalls (model_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    -1,
    'b6000000-0000-0000-0000-000000000020'
  )
  $$,
  '23514',
  null,
  'rung positions start at zero'
);

insert into public.model_waterfalls (model_id, org_id, position, model_provider_id)
values
  (
    'b6000000-0000-0000-0000-000000000010',
    'b6000000-0000-0000-0000-000000000002',
    0,
    'b6000000-0000-0000-0000-000000000021'
  ),
  (
    'b6000000-0000-0000-0000-000000000010',
    'b6000000-0000-0000-0000-000000000002',
    1,
    'b6000000-0000-0000-0000-000000000020'
  );

select is(
  (
    select array_agg(providers.provider order by rungs.position)
    from public.model_waterfalls rungs
    join public.model_providers providers
      on providers.id = rungs.model_provider_id
    where rungs.model_id = 'b6000000-0000-0000-0000-000000000010'
      and rungs.org_id = 'b6000000-0000-0000-0000-000000000002'
  ),
  array['bedrock', 'anthropic'],
  'an org override is its own ordered chain, positions reused from zero'
);

select is(
  (
    select array_agg(providers.provider order by rungs.position)
    from public.model_waterfalls rungs
    join public.model_providers providers
      on providers.id = rungs.model_provider_id
    where rungs.model_id = 'b6000000-0000-0000-0000-000000000010'
      and rungs.org_id is null
  ),
  array['anthropic', 'bedrock', 'openrouter'],
  'the org override leaves the default chain untouched'
);

-- The composite FK makes cross-model rungs structurally impossible: a chain
-- for one model cannot name another model's deployment.

insert into public.models (id, slug, display_name)
values (
  'b6000000-0000-0000-0000-000000000012',
  'gpt-5.5',
  'GPT-5.5'
);

insert into public.model_providers (id, model_id, provider, provider_model_id)
values (
  'b6000000-0000-0000-0000-000000000024',
  'b6000000-0000-0000-0000-000000000012',
  'openai',
  'gpt-5.5'
);

select throws_ok(
  $$
  insert into public.model_waterfalls (model_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    3,
    'b6000000-0000-0000-0000-000000000024'
  )
  $$,
  '23503',
  null,
  'a waterfall rung cannot point at another model''s deployment'
);

-- Cascade: deleting a deployment removes its rungs but never the model.

delete from public.model_providers
where id = 'b6000000-0000-0000-0000-000000000022';

select is(
  (
    select count(*)::int from public.model_waterfalls
    where model_provider_id = 'b6000000-0000-0000-0000-000000000022'
  ),
  0,
  'deleting a deployment removes its waterfall rungs'
);

-- Validation checks: bounds, vocabularies, and jsonb shapes.

select throws_ok(
  $$
  insert into public.models (slug, display_name, context_window)
  values ('bad-context', 'Bad Context', 0)
  $$,
  '23514',
  null,
  'context_window must be positive when present'
);

select throws_ok(
  $$
  insert into public.models (slug, display_name, input_modalities)
  values ('bad-modality', 'Bad Modality', '{telepathy}')
  $$,
  '23514',
  null,
  'modalities draw from the documented vocabulary'
);

select throws_ok(
  $$
  insert into public.models (slug, display_name, output_modalities)
  values ('empty-modality', 'Empty Modality', '{}')
  $$,
  '23514',
  null,
  'modality lists are never empty'
);

select throws_ok(
  $$
  insert into public.models (slug, display_name, supported_params)
  values ('bad-params', 'Bad Params', '[]'::jsonb)
  $$,
  '23514',
  null,
  'supported_params is a jsonb object'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, capabilities)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'gemini',
    'gemini-flash-3.7',
    '"streaming"'::jsonb
  )
  $$,
  '23514',
  null,
  'capabilities is a jsonb object'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, base_url)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    ''
  )
  $$,
  '23514',
  null,
  'a local base_url must be a real endpoint, not a blank'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, base_url)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'openai',
    'gpt-5.5',
    'https://sneaky.example.com/v1'
  )
  $$,
  '23514',
  null,
  'base_url is exclusive to local: a hosted row carrying one would mint a duplicate route identity'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, base_url)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'http://?query'
  )
  $$,
  '23514',
  null,
  'a hostless base_url (http://?query) is rejected at write time'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, base_url)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'http://#fragment'
  )
  $$,
  '23514',
  null,
  'a hostless base_url (http://#fragment) is rejected at write time'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, base_url)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'http://a?b'
  )
  $$,
  '23514',
  null,
  'a base_url carrying a query string is rejected: meaningless in a base URL'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, base_url)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'http://a#fragment'
  )
  $$,
  '23514',
  null,
  'a base_url carrying a fragment is rejected: meaningless in a base URL'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, base_url)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'http://[::1'
  )
  $$,
  '23514',
  null,
  'an unclosed IPv6 literal is rejected'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, base_url)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'http://a:99999'
  )
  $$,
  '23514',
  null,
  'an out-of-range port is rejected'
);

select lives_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, base_url, owning_org_id
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'http://[::1]:8000/v1',
    'b6000000-0000-0000-0000-000000000002'
  )
  $$,
  'a closed IPv6 literal with a valid port and path is a routable endpoint'
);

select lives_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, base_url, owning_org_id
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'local',
    'claude-opus-5-gguf',
    'http://10.0.0.5:8000/v1',
    'b6000000-0000-0000-0000-000000000001'
  )
  $$,
  'plain http stays legal: cluster-internal serving URLs terminate TLS at the ingress'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'modal',
    'claude-opus-5-modal'
  )
  $$,
  '23514',
  null,
  'a modal deployment requires its base_url: modal endpoints are org-deployed, not a fixed origin'
);

select lives_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, base_url, owning_org_id
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'modal',
    'claude-opus-5-modal',
    'https://org-a--claude-opus-5.modal.run/v1',
    'b6000000-0000-0000-0000-000000000001'
  )
  $$,
  'a modal deployment with its endpoint is an ordinary routable row'
);

select throws_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, base_url, owning_org_id
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'modal',
    'claude-opus-5-modal',
    'https://org-a--claude-opus-5.modal.run/v1',
    'b6000000-0000-0000-0000-000000000001'
  )
  $$,
  '23505',
  null,
  'a duplicated modal route collides on the identity key like any other'
);

-- Tenancy: org assignments are birth-time and immutable.

select throws_ok(
  $$
  update public.models
  set owning_org_id = 'b6000000-0000-0000-0000-000000000002'
  where id = 'b6000000-0000-0000-0000-000000000011'
  $$,
  '23514',
  null,
  'a model cannot be re-homed across tenants in place'
);

-- Tenancy: a private model admits only its owner's deployments.
-- b6...11 is org A's private model.

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id, owning_org_id)
  values (
    'b6000000-0000-0000-0000-000000000011',
    'anthropic',
    'claude-opus-5',
    'b6000000-0000-0000-0000-000000000002'
  )
  $$,
  '23514',
  null,
  'another org cannot attach deployments to a private model'
);

select throws_ok(
  $$
  insert into public.model_providers (model_id, provider, provider_model_id)
  values (
    'b6000000-0000-0000-0000-000000000011',
    'anthropic',
    'claude-opus-5'
  )
  $$,
  '23514',
  null,
  'a public deployment cannot attach to a private model'
);

select lives_ok(
  $$
  insert into public.model_providers (
    id, model_id, provider, provider_model_id, base_url, owning_org_id, billing_source
  )
  values (
    'b6000000-0000-0000-0000-000000000025',
    'b6000000-0000-0000-0000-000000000011',
    'local',
    'org-a-legacy-serving',
    'https://legacy.org-a.internal/v1',
    'b6000000-0000-0000-0000-000000000001',
    'host_managed'
  )
  $$,
  'the legacy-consolidation shape works: an org''s private model with its own local deployment'
);

-- Tenancy: BYOK pins belong to the deployment's org and provider.

insert into public.provider_connections (id, org_id, provider, vault_secret_id)
values (
  'b6000000-0000-0000-0000-000000000030',
  'b6000000-0000-0000-0000-000000000001',
  'anthropic',
  'b6000000-0000-0000-0000-000000000031'
);

select throws_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, provider_connection_id
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'anthropic',
    'claude-opus-5-pinned',
    'b6000000-0000-0000-0000-000000000030'
  )
  $$,
  '23514',
  null,
  'a public deployment cannot pin an org''s BYOK connection'
);

select throws_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, owning_org_id, provider_connection_id
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'anthropic',
    'claude-opus-5-pinned',
    'b6000000-0000-0000-0000-000000000002',
    'b6000000-0000-0000-0000-000000000030'
  )
  $$,
  '23503',
  null,
  'a deployment cannot pin another org''s connection'
);

select throws_ok(
  $$
  insert into public.model_providers (
    model_id, provider, provider_model_id, owning_org_id, provider_connection_id
  )
  values (
    'b6000000-0000-0000-0000-000000000010',
    'openai',
    'gpt-5.5-pinned',
    'b6000000-0000-0000-0000-000000000001',
    'b6000000-0000-0000-0000-000000000030'
  )
  $$,
  '23514',
  null,
  'a pinned connection must match the deployment''s provider'
);

select lives_ok(
  $$
  insert into public.model_providers (
    id, model_id, provider, provider_model_id, owning_org_id, provider_connection_id
  )
  values (
    'b6000000-0000-0000-0000-000000000026',
    'b6000000-0000-0000-0000-000000000010',
    'anthropic',
    'claude-opus-5-pinned',
    'b6000000-0000-0000-0000-000000000001',
    'b6000000-0000-0000-0000-000000000030'
  )
  $$,
  'an org deployment pins its own same-provider connection'
);

delete from public.provider_connections
where id = 'b6000000-0000-0000-0000-000000000030';

select ok(
  (
    select provider_connection_id is null
      and owning_org_id = 'b6000000-0000-0000-0000-000000000001'
    from public.model_providers
    where id = 'b6000000-0000-0000-0000-000000000026'
  ),
  'losing the pinned connection clears only the pin; the deployment and its org survive'
);

-- Tenancy: chains route only public deployments or the chain tenant's own.
-- b6...23 is org A's private local deployment on the public model b6...10.

select throws_ok(
  $$
  insert into public.model_waterfalls (model_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    3,
    'b6000000-0000-0000-0000-000000000023'
  )
  $$,
  '23514',
  null,
  'the default chain of a public model cannot include an org''s private deployment'
);

select throws_ok(
  $$
  insert into public.model_waterfalls (model_id, org_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'b6000000-0000-0000-0000-000000000002',
    2,
    'b6000000-0000-0000-0000-000000000023'
  )
  $$,
  '23514',
  null,
  'an org''s override cannot include another org''s private deployment'
);

select lives_ok(
  $$
  insert into public.model_waterfalls (model_id, org_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000010',
    'b6000000-0000-0000-0000-000000000001',
    0,
    'b6000000-0000-0000-0000-000000000023'
  )
  $$,
  'an org''s override routes through its own private deployment'
);

-- Tenancy: chains on a private model belong to its owner.

select throws_ok(
  $$
  insert into public.model_waterfalls (model_id, org_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000011',
    'b6000000-0000-0000-0000-000000000002',
    0,
    'b6000000-0000-0000-0000-000000000025'
  )
  $$,
  '23514',
  null,
  'another org cannot hold a chain on a private model'
);

select lives_ok(
  $$
  insert into public.model_waterfalls (model_id, position, model_provider_id)
  values (
    'b6000000-0000-0000-0000-000000000011',
    0,
    'b6000000-0000-0000-0000-000000000025'
  )
  $$,
  'a private model''s default chain reaches the owner''s own deployment (effective-tenant rule)'
);

select * from finish();

rollback;
