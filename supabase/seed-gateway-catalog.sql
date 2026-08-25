-- Gateway catalog seed and production backfill (core-P2, extended in gw-r2):
-- the house org that funds the platform lane, its provider connections
-- (secrets into Vault via the existing upsert_provider_connection RPC), the
-- pinned preferred models with their launch deployments and default
-- waterfalls, the current Claude family and qwen3.8-27b appended to the
-- preferred list, and a broad priced cross-section of live OpenRouter models
-- so the storefront reads full. Every catalog row carries a logo key (icon),
-- a release date, live prices, and current uptime.
--
-- The legacy-endpoint fold was removed in gw-r2: promoting dead Project-era
-- endpoints (customer-support, terminal-use, coding) into the catalog as
-- owned/local models surfaced them as artifacts under the storefront's
-- "local" filter, contrary to the product boundary that Project serving is
-- the only serving lane and legacy data is history-only. Those endpoints
-- rows stay in the database for usage history; they are no longer catalog
-- models.
--
-- Idempotent by natural keys, so it is safe to re-run on the local docker
-- stack, Supabase preview branches, and production (the production run is
-- a manual operator step). Catalog rows upsert (this file is the source of
-- truth for the pinned launch list);
-- waterfall rungs are create-if-missing so a re-run never rewrites a chain
-- the management API has since edited. Prices, stats, icons, and release
-- dates are last-writer-wins from the live OpenRouter pull.
--
-- Callers pass provider secrets as psql -v variables named after the standard
-- environment variables, same convention as seed-secrets.sql. Unset or empty
-- values skip their row with a notice, so this file is safe to \i
-- unconditionally after seed.sql.

\set ON_ERROR_STOP on

\if :{?OPENAI_API_KEY}
\else
  \set OPENAI_API_KEY ''
\endif
\if :{?ANTHROPIC_API_KEY}
\else
  \set ANTHROPIC_API_KEY ''
\endif
\if :{?AZURE_OPENAI_API_KEY}
\else
  \set AZURE_OPENAI_API_KEY ''
\endif
\if :{?AZURE_OPENAI_ENDPOINT}
\else
  \set AZURE_OPENAI_ENDPOINT ''
\endif
\if :{?OPENROUTER_API_KEY}
\else
  \set OPENROUTER_API_KEY ''
\endif
\if :{?AWS_ACCESS_KEY_ID}
\else
  \set AWS_ACCESS_KEY_ID ''
\endif
\if :{?AWS_SECRET_ACCESS_KEY}
\else
  \set AWS_SECRET_ACCESS_KEY ''
\endif
\if :{?AWS_REGION}
\else
  \set AWS_REGION ''
\endif
\if :{?GEMINI_API_KEY}
\else
  \set GEMINI_API_KEY ''
\endif
\if :{?FIREWORKS_API_KEY}
\else
  \set FIREWORKS_API_KEY ''
\endif

-- 1. The house organization: owner of the platform-funded lane. Requests that
-- spend platform credits resolve their provider credential from this org's
-- provider_connections rows (plan Q5: connections under a house org,
-- not env vars). Upsert on the stable primary key like the other seeded orgs.
insert into public.organizations (id, slug, name)
values (
  '00000000-0000-0000-0000-000000000004',
  'experiential-labs-house',
  'Experiential Labs House'
)
on conflict (id) do update set
  slug = excluded.slug,
  name = excluded.name;

-- 2. House provider connections through the Vault RPC path. The credential
-- only ever lives in Vault; re-running with a new value rotates the secret in
-- place (upsert_provider_connection semantics).
create or replace function pg_temp.seed_house_connection(
  in_provider text,
  in_config jsonb,
  in_secret text,
  env_name text
)
returns void
language plpgsql
as $$
begin
  if nullif(in_secret, '') is null then
    raise notice 'Skipping house % connection because % is unset.',
      in_provider,
      env_name;
    return;
  end if;

  perform public.upsert_provider_connection(
    '00000000-0000-0000-0000-000000000004',
    in_provider,
    in_config,
    in_secret,
    'seed-gateway-catalog'
  );
end;
$$;

select pg_temp.seed_house_connection('openai', '{}'::jsonb, :'OPENAI_API_KEY', 'OPENAI_API_KEY');
select pg_temp.seed_house_connection(
  'anthropic', '{}'::jsonb, :'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'
);
select pg_temp.seed_house_connection('openrouter', '{}'::jsonb, :'OPENROUTER_API_KEY', 'OPENROUTER_API_KEY');

-- Azure carries its resource endpoint as non-secret config; a key without an
-- endpoint (or the reverse) is unusable, so the pair seeds together or fails
-- loudly rather than storing a half-configured connection.
create or replace function pg_temp.seed_house_azure_openai(
  azure_endpoint text,
  azure_key text
)
returns void
language plpgsql
as $$
begin
  if (nullif(azure_endpoint, '') is null) <> (nullif(azure_key, '') is null) then
    raise exception
      'AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT must be set together';
  end if;
  -- config carries the resource endpoint, the pinned api_version, and the
  -- identity deployment map (name->name) the house lane's azure_openai routes
  -- resolve against (provision-house-lane's authoritative map, section 9).
  perform pg_temp.seed_house_connection(
    'azure_openai',
    jsonb_build_object(
      'endpoint', azure_endpoint,
      'api_version', '2024-10-21',
      'deployments', jsonb_build_object(
        'grok-4.3', 'grok-4.3',
        'DeepSeek-V4-Pro', 'DeepSeek-V4-Pro',
        'Kimi-K2.6', 'Kimi-K2.6',
        'FW-GLM-5.2', 'FW-GLM-5.2',
        'grok-4-20-reasoning', 'grok-4-20-reasoning',
        'mistral-medium-3-5', 'mistral-medium-3-5',
        'Kimi-K2.5', 'Kimi-K2.5',
        'Kimi-K2.7-Code', 'Kimi-K2.7-Code',
        'DeepSeek-V4-Flash', 'DeepSeek-V4-Flash',
        'DeepSeek-V4-Flash-0731', 'DeepSeek-V4-Flash-0731',
        'FW-Kimi-K3', 'FW-Kimi-K3',
        'FW-Nemotron-3-Ultra-NVFP4', 'FW-Nemotron-3-Ultra-NVFP4',
        'FW-Nemotron-Lightning-3.5-30B-A3B', 'FW-Nemotron-Lightning-3.5-30B-A3B'
      )
    ),
    azure_key,
    'AZURE_OPENAI_API_KEY'
  );
end;
$$;

select pg_temp.seed_house_azure_openai(:'AZURE_OPENAI_ENDPOINT', :'AZURE_OPENAI_API_KEY');

-- Bedrock: region and access key id are non-secret config, the secret access
-- key is the Vault credential (same split as BYOK Bedrock bindings). The
-- triple seeds together or fails loudly.
create or replace function pg_temp.seed_house_bedrock(
  aws_region text,
  aws_access_key_id text,
  aws_secret_access_key text
)
returns void
language plpgsql
as $$
begin
  if nullif(aws_secret_access_key, '') is null
    and nullif(aws_access_key_id, '') is null then
    raise notice 'Skipping house bedrock connection because AWS credentials are unset.';
    return;
  end if;
  if nullif(aws_secret_access_key, '') is null
    or nullif(aws_access_key_id, '') is null
    or nullif(aws_region, '') is null then
    raise exception
      'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION must be set together';
  end if;
  perform pg_temp.seed_house_connection(
    'bedrock',
    jsonb_build_object('region', aws_region, 'access_key_id', aws_access_key_id),
    aws_secret_access_key,
    'AWS_SECRET_ACCESS_KEY'
  );
end;
$$;

select pg_temp.seed_house_bedrock(:'AWS_REGION', :'AWS_ACCESS_KEY_ID', :'AWS_SECRET_ACCESS_KEY');

-- Gemini: no key exists in any deployment or local env as of 2026-08-19
-- (verified across the platform and world-model-harness env files; plan
-- section 8 makes providing one a manual operator step). The plumbing is
-- ready: once GEMINI_API_KEY lands in the deployment env, re-running this file
-- seeds the connection.
select pg_temp.seed_house_connection('gemini', '{}'::jsonb, :'GEMINI_API_KEY', 'GEMINI_API_KEY');

-- Fireworks: serverless models on the house lane (qwen3.7/3.8, kimi, deepseek,
-- nemotron fallbacks per section 9). Credential-only connection like openrouter.
select pg_temp.seed_house_connection('fireworks', '{}'::jsonb, :'FIREWORKS_API_KEY', 'FIREWORKS_API_KEY');

-- 3. The launch catalog models: Kimi K2.6, GLM 5.3, the GPT-5.6 line (sol,
-- terra, luna), GPT-5.5, Gemini Flash 3.7, DeepSeek V4 Flash, DeepSeek V4
-- Pro, the older Gemini models (3.5 Flash, 3.5 Flash Lite), then the Qwen
-- series (3.5 9B, 3.6 27B). No preferred_rank here: the recommended set is
-- admin-managed (recommended_models_apply) and section 8 is the seed's single
-- rank writer, applying the defaults only to a database with no ranked model.
--
-- Sources: wire ids, prices, context windows, and parameter support for the
-- OpenRouter-served rows were verified live against the public OpenRouter
-- catalog (GET https://openrouter.ai/api/v1/models, 2026-08-19); the OpenAI
-- and Gemini rows carry the values WMO verified against provider
-- documentation (world-model-optimizer wmo/common/models/known_models.py).
-- Release dates are left null rather than approximated from listing dates;
-- the data-fill packet researches them.
insert into public.models (
  slug,
  display_name,
  context_window,
  max_output_tokens,
  input_modalities,
  supported_params
)
values
  (
    'kimi-k2.6',
    'Kimi K2.6',
    262144,
    262144,
    '{text,image}',
    '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}'
  ),
  (
    'glm-5.3',
    'GLM 5.3',
    1048576,
    131072,
    '{text}',
    '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": false, "stop": false, "seed": false, "logprobs": false}'
  ),
  (
    'gpt-5.6-sol',
    'GPT-5.6 Sol',
    1050000,
    128000,
    '{text,image}',
    '{"tools": true, "temperature": false, "top_p": false, "reasoning": true, "response_format": true, "structured_outputs": true}'
  ),
  (
    'gpt-5.6-terra',
    'GPT-5.6 Terra',
    1050000,
    128000,
    '{text,image}',
    '{"tools": true, "temperature": false, "top_p": false, "reasoning": true, "response_format": true, "structured_outputs": true}'
  ),
  (
    'gpt-5.6-luna',
    'GPT-5.6 Luna',
    1050000,
    128000,
    '{text,image}',
    '{"tools": true, "temperature": false, "top_p": false, "reasoning": true, "response_format": true, "structured_outputs": true}'
  ),
  (
    'gpt-5.5',
    'GPT-5.5',
    1050000,
    128000,
    '{text,image}',
    '{"tools": true, "temperature": false, "top_p": false, "reasoning": true, "response_format": true, "structured_outputs": true}'
  ),
  (
    'gemini-3.7-flash',
    'Gemini 3.7 Flash',
    1048576,
    65536,
    '{text,image,audio,video,pdf}',
    '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": false}'
  ),
  (
    'deepseek-v4-flash',
    'DeepSeek V4 Flash',
    1048576,
    384000,
    '{text}',
    '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}'
  ),
  (
    'deepseek-v4-pro',
    'DeepSeek V4 Pro',
    1048576,
    393216,
    '{text}',
    '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}'
  ),
  (
    'gemini-3.5-flash',
    'Gemini 3.5 Flash',
    1048576,
    65536,
    '{text,image,audio,video,pdf}',
    '{"tools": true, "temperature": true, "response_format": true, "structured_outputs": true}'
  ),
  (
    'gemini-3.5-flash-lite',
    'Gemini 3.5 Flash Lite',
    1048576,
    65536,
    '{text,image,audio,video,pdf}',
    '{"tools": true, "temperature": true, "response_format": true, "structured_outputs": true}'
  ),
  (
    'qwen3.5-9b',
    'Qwen3.5 9B',
    262144,
    262144,
    '{text,image,video}',
    '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}'
  ),
  (
    'qwen3.6-27b',
    'Qwen3.6 27B',
    262144,
    65536,
    '{text,image,video}',
    '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}'
  )
-- models_namespace_slug_key is NULLS NOT DISTINCT, so public rows (null
-- owning_org_id) collide with each other and this upsert converges them.
on conflict (slug, owning_org_id) do update set
  display_name = excluded.display_name,
  context_window = excluded.context_window,
  max_output_tokens = excluded.max_output_tokens,
  input_modalities = excluded.input_modalities,
  supported_params = excluded.supported_params,
  status = 'active';

-- 4. Launch deployments for the preferred models. One verified route per
-- model; the data-fill packet (core-P17) adds provider breadth through the
-- management API. Prices are integer micro-USD per million tokens
-- (GatewayTokenPrices); null means unknown, never zero.
--
-- Ownership model (enforced by the core-P1 tenancy guards): public models
-- carry public deployments (owning_org_id null) with NO provider_connection
-- pin; pins exist only on an org's own private deployments. The
-- platform-funded lane resolves its credentials from the house org's
-- provider_connections at catalog-build time, never via per-deployment pins.
--
-- Deliberately absent, for the data-fill packet:
--   - Native gemini deployments for gemini-3.7-flash (the native wire id is
--     unverified until the Gemini key lands; the OpenRouter route below is
--     verified and callable today).
--
-- Experiential Cloud (native vLLM) rows are seeded in the dedicated section
-- after the default waterfalls. They stay unroutable until the worker is
-- given EXPLABS_EXPERIENTIAL_CLOUD_BASE_URL; existing Azure / Fireworks /
-- OpenRouter rungs keep serving until that cutover.
-- billing_source is host_managed on every preferred deployment: these are
-- the routes the platform funds through the house connections, and the
-- gateway admits a platform-lane request only on a host_managed row.
--
-- capabilities carries the GatewayDeploymentCapabilities booleans the
-- gateway gates on (absent = false, the contract default). supports_streaming
-- is true everywhere: the gateway executes every provider via streaming
-- internally, so a row without it is unservable. The rest are declared only
-- where verified (OpenAI protocol docs for openai rows; the OpenRouter
-- supported_parameters listing for openrouter rows; Gemini API docs for
-- gemini rows). Pricing coupling is deliberate and load-bearing:
-- reports_cached_input_tokens is claimed only where a cached rate is seeded
-- (qwen3.5-9b publishes none, so it claims none), and reports_reasoning_tokens
-- stays false everywhere because no reasoning rate is seeded — a reported
-- token kind without a rate makes the worst-case cost incomputable and caps
-- reject the route (P1013). core-P18's per-model verification refines both
-- sides of that coupling together.
insert into public.model_providers (
  model_id,
  provider,
  provider_model_id,
  billing_source,
  input_micro_usd_per_million,
  cached_input_micro_usd_per_million,
  output_micro_usd_per_million,
  pricing_source,
  pricing_effective_at,
  capabilities
)
select
  models.id,
  deployments.provider,
  deployments.provider_model_id,
  'host_managed',
  deployments.input_micro,
  deployments.cached_micro,
  deployments.output_micro,
  deployments.pricing_source,
  '2026-08-19T00:00:00Z'::timestamptz,
  deployments.capabilities::jsonb
from (
  values
    ('kimi-k2.6', 'openrouter', 'moonshotai/kimi-k2.6', 541500::bigint, 91200::bigint, 2280000::bigint, 'openrouter',
      '{"supports_streaming": true, "supports_parallel_tool_calls": true, "supports_structured_text": true, "supports_stop_sequences": true, "reports_cached_input_tokens": true}'),
    ('glm-5.3', 'openrouter', 'z-ai/glm-5.3', 1400000, 260000, 4400000, 'openrouter',
      '{"supports_streaming": true, "reports_cached_input_tokens": true}'),
    ('gpt-5.6-sol', 'openai', 'gpt-5.6-sol', 5000000, 500000, 30000000, 'provider-docs',
      '{"supports_streaming": true, "supports_developer_messages": true, "supports_streaming_tool_arguments": true, "supports_strict_tools": true, "supports_parallel_tool_calls": true, "supports_structured_text": true, "reports_refusals": true, "reports_cached_input_tokens": true}'),
    ('gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 2000000, 200000, 12000000, 'provider-docs',
      '{"supports_streaming": true, "supports_developer_messages": true, "supports_streaming_tool_arguments": true, "supports_strict_tools": true, "supports_parallel_tool_calls": true, "supports_structured_text": true, "reports_refusals": true, "reports_cached_input_tokens": true}'),
    ('gpt-5.6-luna', 'openai', 'gpt-5.6-luna', 200000, 20000, 1200000, 'provider-docs',
      '{"supports_streaming": true, "supports_developer_messages": true, "supports_streaming_tool_arguments": true, "supports_strict_tools": true, "supports_parallel_tool_calls": true, "supports_structured_text": true, "reports_refusals": true, "reports_cached_input_tokens": true}'),
    ('gpt-5.5', 'openai', 'gpt-5.5', 5000000, 500000, 30000000, 'provider-docs',
      '{"supports_streaming": true, "supports_developer_messages": true, "supports_streaming_tool_arguments": true, "supports_strict_tools": true, "supports_parallel_tool_calls": true, "supports_structured_text": true, "reports_refusals": true, "reports_cached_input_tokens": true}'),
    ('gemini-3.7-flash', 'openrouter', 'google/gemini-3.7-flash', 375000, 37500, 1875000, 'openrouter',
      '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "reports_cached_input_tokens": true}'),
    ('deepseek-v4-flash', 'openrouter', 'deepseek/deepseek-v4-flash', 74200, 14840, 148400, 'openrouter',
      '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "reports_cached_input_tokens": true}'),
    ('deepseek-v4-pro', 'openrouter', 'deepseek/deepseek-v4-pro', 1440000, 121500, 2880000, 'openrouter',
      '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "reports_cached_input_tokens": true}'),
    ('gemini-3.5-flash', 'gemini', 'gemini-3.5-flash', 1500000, 150000, 9000000, 'provider-docs',
      '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "reports_cached_input_tokens": true}'),
    ('gemini-3.5-flash-lite', 'gemini', 'gemini-3.5-flash-lite', 300000, 30000, 2500000, 'provider-docs',
      '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "reports_cached_input_tokens": true}'),
    ('qwen3.5-9b', 'openrouter', 'qwen/qwen3.5-9b', 100000, null, 150000, 'openrouter',
      '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true}'),
    ('qwen3.6-27b', 'openrouter', 'qwen/qwen3.6-27b', 300000, 30000, 2000000, 'openrouter',
      '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "reports_cached_input_tokens": true}')
) as deployments(slug, provider, provider_model_id, input_micro, cached_micro, output_micro, pricing_source, capabilities)
join public.models models
  on models.slug = deployments.slug
  and models.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url)
do update set
  billing_source = excluded.billing_source,
  input_micro_usd_per_million = excluded.input_micro_usd_per_million,
  cached_input_micro_usd_per_million = excluded.cached_input_micro_usd_per_million,
  output_micro_usd_per_million = excluded.output_micro_usd_per_million,
  pricing_source = excluded.pricing_source,
  pricing_effective_at = excluded.pricing_effective_at,
  capabilities = excluded.capabilities;

-- Default waterfalls: each preferred model's chain starts at its single
-- verified deployment. Create-if-missing: once the management API owns chain
-- edits (reorders, added rungs), a re-seed must not rewrite them.
insert into public.model_waterfalls (model_id, position, model_provider_id)
select distinct on (deployments.model_id) deployments.model_id, 0, deployments.id
from public.model_providers deployments
join public.models models
  on models.id = deployments.model_id
  and models.owning_org_id is null
  -- The section-3 models by name (ranks no longer exist at this point in the
  -- file; the recommended set is applied, guarded, in section 8). KEEP THIS
  -- LIST IN SYNC WITH SECTION 3'S INSERT: a model added there but omitted here
  -- gets no launch waterfall (rung 0) and is listed-but-unroutable, with no
  -- error at seed time. (Formerly this join keyed on preferred_rank, which the
  -- admin-managed recommended set removed.)
  and models.slug in (
    'kimi-k2.6', 'glm-5.3', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gpt-5.5', 'gemini-3.7-flash', 'deepseek-v4-flash', 'deepseek-v4-pro',
    'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'qwen3.5-9b', 'qwen3.6-27b'
  )
where deployments.owning_org_id is null
order by deployments.model_id, deployments.created_at, deployments.id
on conflict (model_id, org_id, position) do nothing;

-- 5. qwen3.8-27b + the current Claude family (Opus 5, Sonnet 5, Haiku 4.5).
-- Recommended (preferred_rank) placement happens only in the guarded section 8
-- defaults; these upserts never touch ranks, so a re-seed cannot clobber an
-- admin-curated recommended set. Live OpenRouter prices/modalities/params
-- (GET /api/v1/models, 2026-08-20); host_managed on the house lane.
insert into public.models (
  slug, display_name, release_date, context_window, max_output_tokens,
  input_modalities, supported_params, icon
) values
  ('qwen3.8-27b', 'Qwen3.8 27B', '2026-08-14', 1000000, 131072, '{text,image,video}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'qwen'),
  ('claude-opus-5', 'Claude Opus 5', '2026-07-24', 1000000, 128000, '{text,image,pdf}', '{"tools": true, "temperature": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'anthropic'),
  ('claude-sonnet-5', 'Claude Sonnet 5', '2026-06-30', 1000000, 128000, '{text,image,pdf}', '{"tools": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'anthropic'),
  ('claude-haiku-4.5', 'Claude Haiku 4.5', '2025-10-15', 200000, 64000, '{text,image,pdf}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'anthropic')
on conflict (slug, owning_org_id) do update set
  display_name = excluded.display_name, release_date = excluded.release_date,
  context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens,
  input_modalities = excluded.input_modalities, supported_params = excluded.supported_params,
  icon = excluded.icon, status = 'active';

insert into public.model_providers (
  model_id, provider, provider_model_id, billing_source,
  input_micro_usd_per_million, cached_input_micro_usd_per_million,
  output_micro_usd_per_million, pricing_source, pricing_effective_at,
  capabilities, uptime_30d, stats_source
) select models.id, dep.provider, dep.provider_model_id, 'host_managed',
  dep.input_micro, dep.cached_micro, dep.output_micro, 'openrouter',
  '2026-08-20T03:09:14+00:00'::timestamptz,
  dep.capabilities::jsonb, dep.uptime, 'openrouter'
from (values
  ('qwen3.8-27b', 'openrouter', 'qwen/qwen3.8-27b', 450000::bigint, 50000::bigint, 3200000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}', 99.724::numeric),
  ('claude-opus-5', 'anthropic', 'claude-opus-5', 5000000::bigint, 500000::bigint, 25000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}', 100::numeric),
  ('claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 2000000::bigint, 200000::bigint, 10000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}', 100::numeric),
  ('claude-haiku-4.5', 'anthropic', 'claude-haiku-4-5', 1000000::bigint, 100000::bigint, 5000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}', 100::numeric)
) as dep(slug, provider, provider_model_id, input_micro, cached_micro, output_micro, capabilities, uptime)
join public.models models on models.slug = dep.slug and models.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do update set
  billing_source = excluded.billing_source,
  input_micro_usd_per_million = excluded.input_micro_usd_per_million,
  cached_input_micro_usd_per_million = excluded.cached_input_micro_usd_per_million,
  output_micro_usd_per_million = excluded.output_micro_usd_per_million,
  pricing_source = excluded.pricing_source, pricing_effective_at = excluded.pricing_effective_at,
  capabilities = excluded.capabilities, uptime_30d = excluded.uptime_30d,
  stats_source = excluded.stats_source;

-- Default waterfalls for the new preferred models: rung 0 at their one route.
insert into public.model_waterfalls (model_id, position, model_provider_id)
select distinct on (dep.model_id) dep.model_id, 0, dep.id
from public.model_providers dep
join public.models models on models.id = dep.model_id and models.owning_org_id is null
  and models.slug in ('qwen3.8-27b', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4.5')
where dep.owning_org_id is null
order by dep.model_id, dep.created_at, dep.id
on conflict (model_id, org_id, position) do nothing;

-- 5c. Ox Alpha (pinned at the top of the models page). A stealth reasoning
-- model built for coding and sustained agentic work,
-- served on the house OpenRouter lane. Verified live against GET
-- https://openrouter.ai/api/v1/models (id stealth/ox-alpha, 2026-08-21): $0
-- prompt / $0 completion, 1,048,576-token context, 131,072 max output, text +
-- image + video input. The $0 rate is the model's GENUINE price, not an unknown
-- (null): both base rates are 0, so worst-case cost is computable and the row is
-- servable; the storefront renders "$0", never a dash. The section 8 defaults
-- pin it at preferred_rank 0 on a fresh database, one step above the
-- recommended band's rank 1, so it leads the band and sits first on /models.
insert into public.models (
  slug, display_name, description, context_window, max_output_tokens,
  input_modalities, supported_params, icon
) values
  ('ox-alpha', 'Ox Alpha', 'Ox Alpha is a reasoning model designed for coding, sustained agentic work, and production workloads. It is suited for long-horizon software engineering, complex reasoning, and workflows that combine text with images and video.', 1048576, 131072, '{text,image,video}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true}', 'stealth')
on conflict (slug, owning_org_id) do update set
  display_name = excluded.display_name, description = excluded.description,
  context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens,
  input_modalities = excluded.input_modalities, supported_params = excluded.supported_params,
  icon = excluded.icon, status = 'active';

-- The single verified OpenRouter route, host_managed on the house lane. No
-- cached rate is published, so reports_cached_input_tokens is deliberately NOT
-- claimed (a reported token kind without its rate makes worst-case cost
-- incomputable and would fail the servability gate).
insert into public.model_providers (
  model_id, provider, provider_model_id, billing_source,
  input_micro_usd_per_million, cached_input_micro_usd_per_million,
  output_micro_usd_per_million, pricing_source, pricing_effective_at, capabilities
) select models.id, 'openrouter', 'stealth/ox-alpha', 'host_managed',
  0::bigint, null::bigint, 0::bigint, 'openrouter',
  '2026-08-21T00:00:00Z'::timestamptz,
  '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true}'::jsonb
from public.models where models.slug = 'ox-alpha' and models.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do update set
  billing_source = excluded.billing_source,
  input_micro_usd_per_million = excluded.input_micro_usd_per_million,
  cached_input_micro_usd_per_million = excluded.cached_input_micro_usd_per_million,
  output_micro_usd_per_million = excluded.output_micro_usd_per_million,
  pricing_source = excluded.pricing_source, pricing_effective_at = excluded.pricing_effective_at,
  capabilities = excluded.capabilities;

-- Default waterfall: rung 0 at the one verified route. Create-if-missing so a
-- re-seed never rewrites a chain the management API later edited.
insert into public.model_waterfalls (model_id, position, model_provider_id)
select dep.model_id, 0, dep.id
from public.model_providers dep
join public.models models
  on models.id = dep.model_id and models.owning_org_id is null and models.slug = 'ox-alpha'
where dep.owning_org_id is null and dep.provider = 'openrouter'
  and dep.provider_model_id = 'stealth/ox-alpha'
on conflict (model_id, org_id, position) do nothing;

-- 6. Broad priced catalog: a wide cross-section of live OpenRouter models so
-- the storefront reads full. Each is a platform-funded (host_managed) route
-- through the house OpenRouter connection, with live prices, a logo key, and
-- a rung-0 default chain. Not preferred-pinned. Prices/modalities/release
-- dates pulled live from GET /api/v1/models.
insert into public.models (
  slug, display_name, description, release_date, context_window, max_output_tokens,
  input_modalities, supported_params, icon
) values
  -- r2: inkling added via OpenRouter ("go through openrouter for now").
  -- Wire id, prices, context, modalities, and params verified live against GET
  -- https://openrouter.ai/api/v1/models + a live call (2026-08-20). Kept in the
  -- broad catalog (unstarred) as a requested open addition. (muse-spark was
  -- requested too but meta/muse-spark-1.2 returns 403 on our OpenRouter lane
  -- and has no callable route anywhere, so it is NOT listed — a listed public
  -- model must be routable; pending a product call on the muse-glimmer-30b sub.)
  ('inkling', 'Inkling', 'Inkling is an open-weight multimodal mixture-of-experts model from Thinking Machines Lab, with 41B active parameters out of 975B total. It is designed for general-purpose reasoning, coding, and agentic tool-use systems.', '2026-07-17', 1048576, 262144, '{text,image,audio}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "stop": true, "seed": true}', 'thinkingmachines'),
  -- Inkling Small: the smaller sibling. It is discovered on Fireworks
  -- (accounts/fireworks/models/inkling-small, canonical slug `inkling-small`)
  -- and was ALSO on OpenRouter, but the curated catalog only carried `inkling`,
  -- so the catalog showed Inkling Small under Fireworks only. Seeding the
  -- OpenRouter route on the SAME canonical slug reconciles the two lanes onto
  -- one catalog model shown under both providers (identity reconciliation, r3).
  ('inkling-small', 'Inkling Small', 'Inkling Small is the smaller open-weight multimodal mixture-of-experts model from Thinking Machines Lab, tuned for fast, cost-efficient reasoning, coding, and agentic tool-use at a fraction of Inkling''s footprint.', '2026-07-17', 262144, 65536, '{text,image}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "stop": true, "seed": true}', 'thinkingmachines'),
  ('seed-2-1-turbo', 'Seed 2.1 Turbo', 'Seed 2.1 Turbo is a multimodal model from ByteDance Seed for coding and long-horizon agent workflows. It is suited for end-to-end software delivery, multi-step task execution, and understanding visual and...', '2026-08-12', 262144, 262144, '{text,image,video}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'bytedance'),
  ('qwen3.8-2.4t-a95b', 'Qwen3.8 2.4T A95B', 'Qwen3.8 2.4T A95B is an open-weight sparse mixture-of-experts model from Qwen and the open-weight variant of [Qwen3.8 Max](/qwen/qwen3.8-max), with 95 billion active parameters out of 2.4 trillion total. It is...', '2026-08-12', 1048576, 262144, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'qwen'),
  ('seed-2.0-code', 'Seed-2.0-Code', 'Seed 2.0 Code is a model from ByteDance Seed optimized for agentic coding. It is suited for frontend development, multilingual programming tasks, and coding-agent workflows in tools such as Claude...', '2026-08-12', 262144, 131072, '{text,image,video}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'bytedance'),
  ('deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', 'DeepSeek V4 Pro 0813 is a large-scale mixture-of-experts model from DeepSeek. This is the GA release of DeepSeek V4 Pro.', '2026-08-12', 1048576, null, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'deepseek'),
  ('grok-4.6', 'Grok 4.6', 'Grok 4.6 is SpaceXAI''s smartest model with frontier performance on coding, knowledge work, and STEM.', '2026-08-12', 500000, null, '{text,image,pdf}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true, "logprobs": true}', 'xai'),
  ('nemotron-3.5-lightning', 'Nemotron 3.5 Lightning', 'NVIDIA Nemotron 3.5 Lightning is an open mixture-of-experts model from NVIDIA, with 3B active parameters out of 30B total. It is suited for high-throughput agentic workloads and specialized tasks that...', '2026-08-11', 1000000, 131072, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'nvidia'),
  ('sakana-namazu', 'Sakana Namazu', 'Sakana Namazu is a Japanese-specialized reasoning model from Sakana AI, based on Kimi K2.6 with additional training for Japanese language and business contexts. It is suited for Japanese instruction following,...', '2026-08-11', 262144, 65536, '{text,image,pdf}', '{"tools": true, "reasoning": true, "structured_outputs": true}', 'sakana'),
  ('solar-pro4', 'Solar Pro 4', 'Solar Pro 4 is Upstage''s cost-efficient large language model, featuring a 524K context window. It is built for long-horizon tasks and agentic workflows, with strong capabilities in office productivity, document-intensive...', '2026-08-10', 524288, 131072, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true}', 'upstage'),
  ('qwen3.8-max', 'Qwen3.8 Max', 'Qwen3.8 Max is the flagship model in Alibaba''s Qwen3.8 series, the general-availability successor to the Qwen3.8 Max Preview. It is a multimodal reasoning model intended for complex reasoning, visual understanding,...', '2026-08-03', 1000000, 131072, '{text,image,video}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'qwen'),
  ('deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731', 'DeepSeek V4 Flash 0731 is a sparse mixture-of-experts model from DeepSeek, with 13B active parameters out of 284B total. This re-post-trained revision is suited for coding, reasoning, and agent workflows....', '2026-07-31', 1310720, 393216, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'deepseek'),
  ('qwen3.7-flash', 'Qwen3.7 Flash', 'Qwen3.7 Flash is a vision-language reasoning model from Alibaba. It is suited for multimodal agents, visual coding, search, and computer interaction, with strengths in object recognition, spatial understanding, and real-world...', '2026-07-27', 1000000, 65536, '{text,image,video}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "seed": true, "logprobs": true}', 'qwen'),
  ('claude-opus-5-fast', 'Claude Opus 5 (Fast)', 'Fast-mode variant of [Opus 5](/anthropic/claude-opus-5) - identical capabilities with higher output speed at 2x pricing relative to regular Opus 5.', '2026-07-24', 1000000, 128000, '{text,image,pdf}', '{"tools": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'anthropic'),
  ('gemini-3.6-flash', 'Gemini 3.6 Flash', 'Gemini 3.6 Flash is a high-efficiency model from Google for coding, agentic workflows, and web and app development. It is designed to produce polished outputs with fewer unnecessary edits and...', '2026-07-21', 1048576, 65536, '{text,image,video,pdf,audio}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true}', 'google'),
  ('kimi-k3', 'Kimi K3', 'Kimi K3 is a 2.8T parameter open-weight multimodal reasoning model from Moonshot AI. It is suited for complex coding, knowledge work, and long-horizon agentic workflows, and is particularly strong at...', '2026-07-16', 1048576, null, '{text,image,video}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'moonshot'),
  ('gpt-5.6-luna-pro', 'GPT-5.6 Luna Pro', 'GPT-5.6 Luna Pro is the same underlying model as [GPT-5.6 Luna](https://openrouter.ai/openai/gpt-5.6-luna), served with `reasoning.mode` set to `pro` for higher-quality responses on complex tasks.', '2026-07-09', 1050000, 128000, '{pdf,image,text}', '{"tools": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true}', 'openai'),
  ('gpt-5.6-terra-pro', 'GPT-5.6 Terra Pro', 'GPT-5.6 Terra Pro is the same underlying model as [GPT-5.6 Terra](https://openrouter.ai/openai/gpt-5.6-terra), served with `reasoning.mode` set to `pro` for higher-quality responses on complex tasks.', '2026-07-09', 1050000, 128000, '{pdf,image,text}', '{"tools": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true}', 'openai'),
  ('gpt-5.6-sol-pro', 'GPT-5.6 Sol Pro', 'GPT-5.6 Sol Pro is the same underlying model as [GPT-5.6 Sol](https://openrouter.ai/openai/gpt-5.6-sol), served with `reasoning.mode` set to `pro` for higher-quality responses on complex tasks.', '2026-07-09', 1050000, 128000, '{pdf,image,text}', '{"tools": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true}', 'openai'),
  ('grok-4.5', 'Grok 4.5', 'Grok 4.5 is a model from SpaceXAI with frontier performance on coding, knowledge work, and STEM.', '2026-07-08', 500000, null, '{text,image,pdf}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true, "logprobs": true}', 'xai'),
  ('gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)', 'Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image) is Google''s fastest, most cost-efficient Gemini image model, built for high-velocity developer pipelines and rapid-fire visual exploration. It delivers text-to-image generation...', '2026-06-30', 65536, 65536, '{image,text}', '{"temperature": true, "top_p": true, "reasoning": true, "response_format": true, "seed": true}', 'google'),
  ('gemini-3.1-flash-image', 'Nano Banana 2 (Gemini 3.1 Flash Image)', 'Gemini 3.1 Flash Image, a.k.a. "Nano Banana 2," is Google’s latest state of the art image generation and editing model, delivering Pro-level visual quality at Flash speed. It combines advanced...', '2026-06-18', 131072, 32768, '{image,text}', '{"temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true}', 'google'),
  ('gemini-3-pro-image', 'Nano Banana Pro (Gemini 3 Pro Image)', 'Nano Banana Pro is Google’s most advanced image-generation and editing model, built on Gemini 3 Pro. It extends the original Nano Banana with significantly improved multimodal reasoning, real-world grounding, and...', '2026-06-18', 131072, 32768, '{image,text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true}', 'google'),
  ('glm-5.2', 'GLM 5.2', 'GLM 5.2 is a large-scale reasoning model from Z.ai. It supports text input and output with a 1M-token context window, and is suited for long-horizon agent workflows, project-level software engineering,...', '2026-06-16', 1048576, 131072, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'zai'),
  ('kimi-k2.7-code', 'Kimi K2.7 Code', 'MoonshotAI: Kimi K2.7 Code is a coding-focused model in Moonshot AI''s Kimi K2 family, built to complete end-to-end programming tasks reliably over long contexts. It uses a native multimodal mixture-of-experts...', '2026-06-12', 262144, 262144, '{text,image}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'moonshot'),
  -- Claude 5 (Mythos-class) reasoning models pin their sampling and reject an
  -- explicit temperature: sending one is a hard provider 400. Declaring it
  -- unsupported both tells callers "how to call it" via the model-info surface
  -- and lets the gateway omit temperature before dispatch (WMO ModelCapabilities).
  ('claude-fable-5', 'Claude Fable 5', 'Claude Fable 5 is a Mythos-class model from Anthropic, built for autonomous knowledge work and coding. It supports text, image, and file inputs with text output, with reasoning support and...', '2026-06-09', 1000000, 128000, '{text,image,pdf}', '{"tools": true, "temperature": false, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'anthropic'),
  ('nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra', 'NVIDIA Nemotron 3 Ultra is an open frontier-reasoning and orchestration model from NVIDIA, with 55B active parameters out of 550B total (MoE). Built on a hybrid Transformer-Mamba mixture-of-experts architecture, it...', '2026-06-04', 512288, null, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true}', 'nvidia'),
  ('qwen3.7-plus', 'Qwen3.7 Plus', 'Qwen3.7-Plus is a cost-effective model in Alibaba''s Qwen3.7 series. It supports text and image input with text output, building on the series'' text capabilities with a comprehensive upgrade to its...', '2026-06-03', 1000000, 131072, '{text,image}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'qwen'),
  ('claude-opus-4.8-fast', 'Claude Opus 4.8 (Fast)', 'Fast-mode variant of [Opus 4.8](/anthropic/claude-opus-4.8) - identical capabilities with higher output speed at 2x pricing relative to regular Opus 4.8.', '2026-05-27', 1000000, 128000, '{text,image,pdf}', '{"tools": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'anthropic'),
  ('claude-opus-4.8', 'Claude Opus 4.8', 'Claude Opus 4.8 is Anthropic''s most capable generally available model in the Opus family. It supports text, image, and file inputs with text output, with reasoning support and a 1M-token...', '2026-05-27', 1000000, 128000, '{text,image,pdf}', '{"tools": true, "temperature": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'anthropic'),
  ('qwen3.7-max', 'Qwen3.7 Max', 'Qwen3.7-Max is the flagship model in Alibaba''s Qwen3.7 series. It supports text input and output and is designed for agent-centric workloads, with particular strengths in coding, office and productivity tasks,...', '2026-05-21', 1000000, 131072, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'qwen'),
  ('grok-build-0.1', 'Grok Build 0.1', 'Grok Build 0.1 is SpaceXAI’s fast coding model trained specifically for agentic software engineering workflows. It supports text and image inputs with text output, and is optimized for interactive coding...', '2026-05-20', 256000, null, '{text,image,pdf}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true, "logprobs": true}', 'xai'),
  ('claude-opus-4.7-fast', 'Claude Opus 4.7 (Fast)', 'Fast-mode variant of [Opus 4.7](/anthropic/claude-opus-4.7) - identical capabilities with higher output speed at premium 6x pricing.', '2026-05-12', 1000000, 128000, '{text,image,pdf}', '{"tools": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true}', 'anthropic'),
  ('gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', 'Gemini 3.1 Flash Lite is Google’s GA high-efficiency multimodal model optimized for low-latency, high-volume workloads. It supports text, image, video, audio, and PDF inputs, and is designed for lightweight agentic...', '2026-05-07', 1048576, 65536, '{text,image,video,pdf,audio}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true}', 'google'),
  ('gpt-chat-latest', 'GPT Chat Latest', 'GPT Chat Latest points to OpenAI''s stable API alias `chat-latest` that always resolves to the latest Instant chat model used in ChatGPT. As OpenAI rolls out new Instant model updates...', '2026-05-05', 400000, 128000, '{text,image,pdf}', '{"tools": true, "response_format": true, "structured_outputs": true, "seed": true}', 'openai'),
  ('grok-4.3', 'Grok 4.3', 'Grok 4.3 is a reasoning model from SpaceXAI. It accepts text and image inputs with text output, and is suited for agentic workflows, instruction-following tasks, and applications requiring high factual...', '2026-04-30', 1000000, null, '{text,image,pdf}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true, "logprobs": true}', 'xai'),
  ('mistral-medium-3-5', 'Mistral Medium 3.5', 'Mistral Medium 3.5 is a dense 128B instruction-following model from Mistral AI. It supports text and image inputs with text output, and is designed for agentic workflows, coding, and complex...', '2026-04-30', 262144, null, '{text,image,pdf}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true}', 'mistral'),
  ('gpt-5.5-pro', 'GPT-5.5 Pro', 'GPT-5.5 Pro is OpenAI’s high-capability model optimized for deep reasoning and accuracy on complex, high-stakes workloads. It features a 1M+ token context window (922K input, 128K output) with support for...', '2026-04-24', 1050000, 128000, '{pdf,image,text}', '{"tools": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true}', 'openai'),
  ('glm-5.1', 'GLM 5.1', 'GLM-5.1 delivers a major leap in coding capability, with particularly significant gains in handling long-horizon tasks. Unlike previous models built around minute-level interactions, GLM-5.1 can work independently and continuously on...', '2026-04-07', 204800, 128000, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'zai'),
  ('glm-5v-turbo', 'GLM 5V Turbo', 'GLM-5V-Turbo is Z.ai’s first native multimodal agent foundation model, built for vision-based coding and agent-driven tasks. It natively handles image, video, and text inputs, excels at long-horizon planning, complex coding,...', '2026-04-01', 202752, 131072, '{image,text,video}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true}', 'zai'),
  ('grok-4.20-multi-agent', 'Grok 4.20 Multi-Agent', 'Grok 4.20 Multi-Agent is a variant of SpaceXAI’s Grok 4.20 designed for collaborative, agent-based workflows. Multiple agents operate in parallel to conduct deep research, coordinate tool use, and synthesize information...', '2026-03-31', 2000000, null, '{text,image,pdf}', '{"temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "seed": true, "logprobs": true}', 'xai'),
  ('mistral-small-2603', 'Mistral Small 4', 'Mistral Small 4 is the next major release in the Mistral Small family, unifying the capabilities of several flagship Mistral models into a single system. It combines strong reasoning from...', '2026-03-16', 262144, null, '{text,image}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true}', 'mistral'),
  ('glm-5-turbo', 'GLM 5 Turbo', 'GLM-5 Turbo is a new model from Z.ai designed for fast inference and strong performance in agent-driven environments such as OpenClaw scenarios. It is deeply optimized for real-world agent workflows...', '2026-03-15', 202752, 131072, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true}', 'zai'),
  ('nemotron-3-super-120b-a12b', 'Nemotron 3 Super', 'NVIDIA Nemotron 3 Super is a 120B-parameter open hybrid MoE model, activating just 12B parameters for maximum compute efficiency and accuracy in complex multi-agent applications. Built on a hybrid Mamba-Transformer...', '2026-03-11', 1000000, 16384, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'nvidia'),
  ('glm-5', 'GLM 5', 'GLM-5 is Z.ai’s flagship open-source foundation model engineered for complex systems design and long-horizon agent workflows. Built for expert developers, it delivers production-grade performance on large-scale programming tasks, rivaling leading...', '2026-02-11', 204800, 128000, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'zai'),
  ('kimi-k2.5', 'Kimi K2.5', 'Kimi K2.5 is Moonshot AI''s native multimodal model, delivering state-of-the-art visual coding capability and a self-directed agent swarm paradigm. Built on Kimi K2 with continued pretraining over approximately 15T mixed...', '2026-01-27', 262144, 262144, '{text,image}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'moonshot'),
  ('nemotron-3-nano-30b-a3b', 'Nemotron 3 Nano 30B A3B', 'NVIDIA Nemotron 3 Nano 30B A3B is a small language MoE model with highest compute efficiency and accuracy for developers to build specialized agentic AI systems. The model is fully...', '2025-12-14', 262144, 262144, '{text}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true, "logprobs": true}', 'nvidia'),
  ('nova-2-lite-v1', 'Nova 2 Lite', 'Nova 2 Lite is a fast, cost-effective reasoning model for everyday workloads that can process text, images, and videos to generate text. Nova 2 Lite demonstrates standout capabilities in processing...', '2025-12-02', 1000000, 65535, '{text,image,video,pdf}', '{"tools": true, "temperature": true, "top_p": true, "reasoning": true, "stop": true}', 'amazon'),
  ('ministral-14b-2512', 'Ministral 3 14B 2512', 'The largest model in the Ministral 3 family, Ministral 3 14B offers frontier capabilities and performance comparable to its larger Mistral Small 3.2 24B counterpart. A powerful and efficient language...', '2025-12-02', 262144, null, '{text,image}', '{"tools": true, "temperature": true, "top_p": true, "response_format": true, "structured_outputs": true, "stop": true, "seed": true}', 'mistral')
on conflict (slug, owning_org_id) do update set
  display_name = excluded.display_name, description = excluded.description,
  release_date = excluded.release_date, context_window = excluded.context_window,
  max_output_tokens = excluded.max_output_tokens, input_modalities = excluded.input_modalities,
  supported_params = excluded.supported_params, icon = excluded.icon, status = 'active';

insert into public.model_providers (
  model_id, provider, provider_model_id, billing_source,
  input_micro_usd_per_million, cached_input_micro_usd_per_million,
  output_micro_usd_per_million, pricing_source, pricing_effective_at, capabilities
) select models.id, 'openrouter', dep.wire, 'host_managed',
  dep.input_micro, dep.cached_micro, dep.output_micro, 'openrouter',
  '2026-08-20T03:09:14+00:00'::timestamptz, dep.capabilities::jsonb
from (values
  ('inkling', 'thinkingmachines/inkling', 950000::bigint, 160000::bigint, 4050000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  -- Inkling Small on OpenRouter: same canonical `inkling-small` model the
  -- Fireworks discovery lane merges onto, so the catalog shows both providers.
  ('inkling-small', 'thinkingmachines/inkling-small', 250000::bigint, 40000::bigint, 1000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('seed-2-1-turbo', 'bytedance-seed/seed-2-1-turbo', 500000::bigint, null::bigint, 2500000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true}'),
  ('qwen3.8-2.4t-a95b', 'qwen/qwen3.8-2.4t-a95b', 2000000::bigint, 250000::bigint, 6000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('seed-2.0-code', 'bytedance-seed/seed-2.0-code', 500000::bigint, null::bigint, 3000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true}'),
  ('deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-0813', 1188000::bigint, 39600::bigint, 3564000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('grok-4.6', 'x-ai/grok-4.6', 2000000::bigint, 500000::bigint, 6000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('nemotron-3.5-lightning', 'nvidia/nemotron-3.5-lightning', 80000::bigint, 40000::bigint, 200000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('sakana-namazu', 'sakana/sakana-namazu', 950000::bigint, 150000::bigint, 4000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('solar-pro4', 'upstage/solar-pro4', 30000::bigint, 6000::bigint, 120000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('qwen3.8-max', 'qwen/qwen3.8-max', 2000000::bigint, 250000::bigint, 6000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash-0731', 140000::bigint, 28000::bigint, 280000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('qwen3.7-flash', 'qwen/qwen3.7-flash', 30000::bigint, 6000::bigint, 130000::bigint, '{"supports_streaming": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('claude-opus-5-fast', 'anthropic/claude-opus-5-fast', 10000000::bigint, 1000000::bigint, 50000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('gemini-3.6-flash', 'google/gemini-3.6-flash', 750000::bigint, 75000::bigint, 3750000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('kimi-k3', 'moonshotai/kimi-k3', 3000000::bigint, 300000::bigint, 15000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('gpt-5.6-luna-pro', 'openai/gpt-5.6-luna-pro', 200000::bigint, 20000::bigint, 1200000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('gpt-5.6-terra-pro', 'openai/gpt-5.6-terra-pro', 2000000::bigint, 200000::bigint, 12000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('gpt-5.6-sol-pro', 'openai/gpt-5.6-sol-pro', 2500000::bigint, 250000::bigint, 15000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('grok-4.5', 'x-ai/grok-4.5', 2000000::bigint, 300000::bigint, 6000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('gemini-3.1-flash-lite-image', 'google/gemini-3.1-flash-lite-image', 250000::bigint, null::bigint, 1500000::bigint, '{"supports_streaming": true}'),
  ('gemini-3.1-flash-image', 'google/gemini-3.1-flash-image', 500000::bigint, null::bigint, 3000000::bigint, '{"supports_streaming": true, "supports_structured_text": true}'),
  ('gemini-3-pro-image', 'google/gemini-3-pro-image', 2000000::bigint, 200000::bigint, 12000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('glm-5.2', 'z-ai/glm-5.2', 966000::bigint, 193200::bigint, 3036000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('kimi-k2.7-code', 'moonshotai/kimi-k2.7-code', 710000::bigint, 150000::bigint, 3500000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('claude-fable-5', 'anthropic/claude-fable-5', 10000000::bigint, 1000000::bigint, 50000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-ultra-550b-a55b', 600000::bigint, 200000::bigint, 3600000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('qwen3.7-plus', 'qwen/qwen3.7-plus', 320000::bigint, 64000::bigint, 1280000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('claude-opus-4.8-fast', 'anthropic/claude-opus-4.8-fast', 10000000::bigint, 1000000::bigint, 50000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('claude-opus-4.8', 'anthropic/claude-opus-4.8', 5000000::bigint, 500000::bigint, 25000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('qwen3.7-max', 'qwen/qwen3.7-max', 1475000::bigint, 295000::bigint, 4425000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('grok-build-0.1', 'x-ai/grok-build-0.1', 1000000::bigint, 200000::bigint, 2000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('claude-opus-4.7-fast', 'anthropic/claude-opus-4.7-fast', 30000000::bigint, 3000000::bigint, 150000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite', 250000::bigint, 25000::bigint, 1500000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('gpt-chat-latest', 'openai/gpt-chat-latest', 5000000::bigint, 500000::bigint, 30000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('grok-4.3', 'x-ai/grok-4.3', 1250000::bigint, 200000::bigint, 2500000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('mistral-medium-3-5', 'mistralai/mistral-medium-3-5', 1500000::bigint, null::bigint, 7500000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true}'),
  ('gpt-5.5-pro', 'openai/gpt-5.5-pro', 30000000::bigint, null::bigint, 180000000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_parallel_tool_calls": true}'),
  ('glm-5.1', 'z-ai/glm-5.1', 966000::bigint, 179400::bigint, 3036000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('glm-5v-turbo', 'z-ai/glm-5v-turbo', 1200000::bigint, 240000::bigint, 4000000::bigint, '{"supports_streaming": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('grok-4.20-multi-agent', 'x-ai/grok-4.20-multi-agent', 1250000::bigint, 200000::bigint, 2500000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "reports_cached_input_tokens": true}'),
  ('mistral-small-2603', 'mistralai/mistral-small-2603', 150000::bigint, 15000::bigint, 600000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('glm-5-turbo', 'z-ai/glm-5-turbo', 1200000::bigint, 240000::bigint, 4000000::bigint, '{"supports_streaming": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-super-120b-a12b', 85000::bigint, null::bigint, 400000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true}'),
  ('glm-5', 'z-ai/glm-5', 600000::bigint, 120000::bigint, 1920000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('kimi-k2.5', 'moonshotai/kimi-k2.5', 450000::bigint, 70000::bigint, 2250000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('nemotron-3-nano-30b-a3b', 'nvidia/nemotron-3-nano-30b-a3b', 50000::bigint, 30000::bigint, 200000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}'),
  ('nova-2-lite-v1', 'amazon/nova-2-lite-v1', 300000::bigint, null::bigint, 2500000::bigint, '{"supports_streaming": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true}'),
  ('ministral-14b-2512', 'mistralai/ministral-14b-2512', 200000::bigint, 20000::bigint, 200000::bigint, '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true, "supports_parallel_tool_calls": true, "reports_cached_input_tokens": true}')
) as dep(slug, wire, input_micro, cached_micro, output_micro, capabilities)
join public.models models on models.slug = dep.slug and models.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do update set
  billing_source = excluded.billing_source,
  input_micro_usd_per_million = excluded.input_micro_usd_per_million,
  cached_input_micro_usd_per_million = excluded.cached_input_micro_usd_per_million,
  output_micro_usd_per_million = excluded.output_micro_usd_per_million,
  pricing_source = excluded.pricing_source, pricing_effective_at = excluded.pricing_effective_at,
  capabilities = excluded.capabilities;

insert into public.model_waterfalls (model_id, position, model_provider_id)
select distinct on (dep.model_id) dep.model_id, 0, dep.id
from public.model_providers dep
join public.models models on models.id = dep.model_id and models.owning_org_id is null
where dep.owning_org_id is null and dep.provider = 'openrouter'
  and models.preferred_rank is null and models.category is null
order by dep.model_id, dep.created_at, dep.id
on conflict (model_id, org_id, position) do nothing;

-- 7. Backfill the launch preferred rows (core-P2's ranks 1..14) with the r2
-- catalog fields the product asked for: a logo key, the release date, current
-- uptime, and a refresh of every OpenRouter-served price to today's live
-- value (several drifted since the initial seed). Native openai/gemini rows
-- keep their provider-docs prices; only OpenRouter-routed rows are repriced.
update public.models m set
  icon = v.icon, release_date = v.release_date::date
from (values
  ('kimi-k2.6', 'moonshot', '2026-04-20'),
  ('glm-5.3', 'zai', '2026-08-18'),
  ('gpt-5.6-sol', 'openai', '2026-07-09'),
  ('gpt-5.6-terra', 'openai', '2026-07-09'),
  ('gpt-5.6-luna', 'openai', '2026-07-09'),
  ('gpt-5.5', 'openai', '2026-04-24'),
  ('gemini-3.7-flash', 'google', '2026-08-13'),
  ('deepseek-v4-flash', 'deepseek', '2026-04-24'),
  ('deepseek-v4-pro', 'deepseek', '2026-04-24'),
  ('gemini-3.5-flash', 'google', '2026-05-19'),
  ('gemini-3.5-flash-lite', 'google', '2026-07-21'),
  ('qwen3.5-9b', 'qwen', '2026-03-10'),
  ('qwen3.6-27b', 'qwen', '2026-04-27')
) as v(slug, icon, release_date)
where m.slug = v.slug and m.owning_org_id is null;

update public.model_providers dep set
  input_micro_usd_per_million = v.input_micro,
  cached_input_micro_usd_per_million = coalesce(v.cached_micro, dep.cached_input_micro_usd_per_million),
  output_micro_usd_per_million = v.output_micro,
  pricing_source = 'openrouter', pricing_effective_at = '2026-08-20T03:09:14+00:00'::timestamptz,
  uptime_30d = v.uptime, stats_source = 'openrouter'
from (values
  ('kimi-k2.6', 'moonshotai/kimi-k2.6', 950000::bigint, 160000::bigint, 4000000::bigint, 99.9878::numeric),
  ('glm-5.3', 'z-ai/glm-5.3', 1400000::bigint, 260000::bigint, 4400000::bigint, 99.9997::numeric),
  ('gemini-3.7-flash', 'google/gemini-3.7-flash', 375000::bigint, 37500::bigint, 1875000::bigint, 99.5568::numeric),
  ('deepseek-v4-flash', 'deepseek/deepseek-v4-flash', 88606::bigint, 17721::bigint, 177212::bigint, 99.9923::numeric),
  ('deepseek-v4-pro', 'deepseek/deepseek-v4-pro', 1440000::bigint, 121500::bigint, 2880000::bigint, 99.8678::numeric),
  ('qwen3.5-9b', 'qwen/qwen3.5-9b', 100000::bigint, null::bigint, 150000::bigint, 99.9313::numeric),
  ('qwen3.6-27b', 'qwen/qwen3.6-27b', 600000::bigint, 120000::bigint, 3600000::bigint, 99.974::numeric)
) as v(slug, provider_model_id, input_micro, cached_micro, output_micro, uptime),
public.models mm
where dep.model_id = mm.id and mm.owning_org_id is null and mm.slug = v.slug
  and dep.provider = 'openrouter' and dep.provider_model_id = v.provider_model_id
  and dep.owning_org_id is null;

-- Native openai/gemini rows keep their provider-docs prices; refresh only
-- current uptime + stats_source from OpenRouter's endpoint telemetry.
update public.model_providers dep set uptime_30d = v.uptime, stats_source = 'openrouter'
from (values
  ('openai', 'gpt-5.6-sol', 100::numeric),
  ('openai', 'gpt-5.6-terra', 100::numeric),
  ('openai', 'gpt-5.6-luna', 99.9991::numeric),
  ('openai', 'gpt-5.5', 99.8954::numeric),
  ('gemini', 'gemini-3.5-flash', 99.5939::numeric),
  ('gemini', 'gemini-3.5-flash-lite', 99.9064::numeric)
) as v(provider, provider_model_id, uptime)
where dep.provider = v.provider and dep.provider_model_id = v.provider_model_id
  and dep.owning_org_id is null;

-- 7b. Uptime for the broad catalog routes (gw-r2 audit follow-up): OpenRouter
-- exposes per-provider uptime (uptime_last_1d) but NOT throughput or latency
-- (those fields are null for every provider), so uptime is the only live stat
-- to seed here; throughput_tps/latency_p50_ms stay null until measured from
-- our own traffic. Best (highest) provider uptime per model.
update public.model_providers dep set uptime_30d = v.uptime, stats_source = 'openrouter'
from (values
  ('seed-2-1-turbo', 100::numeric),
  ('qwen3.8-2.4t-a95b', 99.8661::numeric),
  ('seed-2.0-code', 100::numeric),
  ('deepseek-v4-pro-0813', 99.6635::numeric),
  ('grok-4.6', 99.8564::numeric),
  ('nemotron-3.5-lightning', 99.9882::numeric),
  ('sakana-namazu', 100::numeric),
  ('solar-pro4', 99.9941::numeric),
  ('qwen3.8-max', 99.9959::numeric),
  ('deepseek-v4-flash-0731', 99.9399::numeric),
  ('qwen3.7-flash', 99.9994::numeric),
  ('claude-opus-5-fast', 99.9963::numeric),
  ('gemini-3.6-flash', 100::numeric),
  ('kimi-k3', 99.5947::numeric),
  ('gpt-5.6-luna-pro', 99.8047::numeric),
  ('gpt-5.6-terra-pro', 100::numeric),
  ('gpt-5.6-sol-pro', 99.9636::numeric),
  ('grok-4.5', 99.8886::numeric),
  ('gemini-3.1-flash-lite-image', 99.8362::numeric),
  ('gemini-3.1-flash-image', 99.4851::numeric),
  ('gemini-3-pro-image', 99.9027::numeric),
  ('glm-5.2', 99.9399::numeric),
  ('kimi-k2.7-code', 100::numeric),
  ('claude-fable-5', 99.9427::numeric),
  ('nemotron-3-ultra-550b-a55b', 98.7309::numeric),
  ('qwen3.7-plus', 99.5035::numeric),
  ('claude-opus-4.8-fast', 99.9873::numeric),
  ('claude-opus-4.8', 100::numeric),
  ('qwen3.7-max', 99.999::numeric),
  ('grok-build-0.1', 99.8752::numeric),
  ('claude-opus-4.7-fast', null::numeric),
  ('gemini-3.1-flash-lite', 100::numeric),
  ('gpt-chat-latest', 100::numeric),
  ('grok-4.3', 99.9487::numeric),
  ('mistral-medium-3-5', 99.9611::numeric),
  ('gpt-5.5-pro', 100::numeric),
  ('glm-5.1', 99.743::numeric),
  ('glm-5v-turbo', 99.0506::numeric),
  ('grok-4.20-multi-agent', 88.8889::numeric),
  ('mistral-small-2603', 99.9191::numeric),
  ('glm-5-turbo', 100::numeric),
  ('nemotron-3-super-120b-a12b', 98.1875::numeric),
  ('glm-5', 99.9774::numeric),
  ('kimi-k2.5', 99.9717::numeric),
  ('nemotron-3-nano-30b-a3b', 99.8718::numeric),
  ('nova-2-lite-v1', 99.9688::numeric),
  ('ministral-14b-2512', 99.8333::numeric)
) as v(slug, uptime),
public.models mm
where dep.model_id = mm.id and mm.owning_org_id is null and mm.slug = v.slug
  and dep.provider = 'openrouter' and dep.owning_org_id is null
  and v.uptime is not null;

-- 8. Recommended set DEFAULTS (gw-r3 list, the 2026-08-22 trim), applied ONLY
-- when no public model carries a preferred_rank yet (a fresh database).
-- The recommended set is ADMIN-MANAGED at runtime: PUT
-- /api/admin/recommended-models (public.recommended_models_apply) and the
-- admin panel's Recommended card own it after first seed, and a re-seed must
-- never clobber an operator's curation. This guarded block is the seed's
-- SINGLE preferred_rank writer — the model upserts in sections 3/5/5c
-- deliberately never touch ranks — and the admin API refuses an empty
-- recommended set, so a rank-managed database can never read as fresh here.
--
-- The default order: Ox Alpha pinned at rank 0 as the top featured model,
-- then Fable and Opus 5 leading the rest as the most-used models.
-- The storefront and every model picker surface these first with a gold star;
-- ALL other real models stay in the catalog under a collapsed per-provider
-- section (a display choice, not a data removal: keep the older models, just
-- fold them). No clear-others pass is needed: the guard
-- guarantees nothing else is ranked. Idempotent; safe to re-run.
do $$
begin
  if exists (
    select 1 from public.models
    where owning_org_id is null and preferred_rank is not null
  ) then
    -- Admin-managed (or already-defaulted): the recommended set belongs to
    -- recommended_models_apply now, leave it alone.
    return;
  end if;
  update public.models m set preferred_rank = v.rank
  from (values
    ('ox-alpha', 0),
    ('claude-fable-5', 1),
    ('claude-opus-5', 2),
    ('claude-sonnet-5', 3),
    ('gpt-5.6-sol', 4),
    ('gpt-5.6-luna', 5),
    ('gemini-3.7-flash', 6),
    ('kimi-k2.6', 7),
    ('glm-5.3', 8),
    ('deepseek-v4-flash', 9),
    ('qwen3.8-27b', 10)
  ) as v(slug, rank)
  where m.slug = v.slug and m.owning_org_id is null;
end;
$$;

-- 8b (retired): the catalog PR's placeholder promo seed was superseded by the
-- authoritative promotional-models seed below (per-org caps + admin-safe
-- upsert); the catalog now only READS model_promotions.

-- 9. House-lane routing (provision-house-lane's authoritative map, gw-r2).
-- "Minimize OpenRouter": route each model through its real primary provider
-- (Anthropic/OpenAI/Gemini direct, Azure, Bedrock, Fireworks) with OpenRouter as
-- the final fallback rung. provision-house-lane owns these route/waterfall rows
-- and verified them live; this is a verbatim transcription (I own the seed file).
-- NOTE (provision): first-party direct anthropic/openai/gemini rung0 currently
-- fails in the pinned WMO adapter and serves via the OpenRouter fallback rung;
-- the map is still correct as written and lights up on the adapter fix.
--
-- 9a. Add the non-OpenRouter primary rows + any missing OpenRouter fallback rows
-- for the mapped models. Every new row copies capabilities AND prices from the
-- model's existing seeded deployment, so no routed row is ever uncallable: an
-- empty '{}' capabilities row fails WMO's forced-streaming preflight, and the
-- source rows all carry supports_streaming. host_managed, public (org null), no
-- per-row connection pin (the house connection resolves the credential).
insert into public.model_providers (
  model_id, provider, provider_model_id, billing_source,
  input_micro_usd_per_million, cached_input_micro_usd_per_million,
  output_micro_usd_per_million, pricing_source, pricing_effective_at, capabilities
)
select m.id, v.provider, v.provider_model_id, 'host_managed',
  src.input_micro_usd_per_million, src.cached_input_micro_usd_per_million,
  src.output_micro_usd_per_million, src.pricing_source,
  '2026-08-20T03:09:14+00:00'::timestamptz, src.capabilities
from (values
  ('claude-fable-5', 'anthropic', 'claude-fable-5'),
  ('claude-opus-4.8', 'anthropic', 'claude-opus-4-8'),
  ('claude-opus-5', 'openrouter', 'anthropic/claude-opus-5'),
  ('claude-sonnet-5', 'openrouter', 'anthropic/claude-sonnet-5'),
  ('claude-haiku-4.5', 'openrouter', 'anthropic/claude-haiku-4.5'),
  ('gpt-5.5', 'openrouter', 'openai/gpt-5.5'),
  ('gpt-5.5-pro', 'openai', 'gpt-5.5-pro'),
  ('gpt-5.6-luna', 'openrouter', 'openai/gpt-5.6-luna'),
  ('gpt-5.6-sol', 'openrouter', 'openai/gpt-5.6-sol'),
  ('gpt-5.6-terra', 'openrouter', 'openai/gpt-5.6-terra'),
  ('gemini-3.5-flash', 'openrouter', 'google/gemini-3.5-flash'),
  ('gemini-3.5-flash-lite', 'openrouter', 'google/gemini-3.5-flash-lite'),
  ('gemini-3.6-flash', 'gemini', 'gemini-3.6-flash'),
  ('gemini-3.7-flash', 'gemini', 'gemini-3.7-flash'),
  ('gemini-3.1-flash-lite', 'gemini', 'gemini-3.1-flash-lite'),
  ('gemini-3.1-flash-image', 'gemini', 'gemini-3.1-flash-image'),
  ('gemini-3.1-flash-lite-image', 'gemini', 'gemini-3.1-flash-lite-image'),
  ('gemini-3-pro-image', 'gemini', 'gemini-3-pro-image'),
  ('grok-4.3', 'azure_openai', 'grok-4.3'),
  ('grok-4.20-multi-agent', 'azure_openai', 'grok-4-20-reasoning'),
  ('kimi-k2.6', 'azure_openai', 'Kimi-K2.6'),
  ('kimi-k2.5', 'azure_openai', 'Kimi-K2.5'),
  ('kimi-k2.5', 'bedrock', 'moonshotai.kimi-k2.5'),
  ('kimi-k2.7-code', 'azure_openai', 'Kimi-K2.7-Code'),
  ('kimi-k2.7-code', 'fireworks', 'accounts/fireworks/models/kimi-k2p7-code'),
  ('kimi-k3', 'azure_openai', 'FW-Kimi-K3'),
  ('kimi-k3', 'fireworks', 'accounts/fireworks/models/kimi-k3'),
  ('glm-5.2', 'azure_openai', 'FW-GLM-5.2'),
  ('glm-5', 'bedrock', 'zai.glm-5'),
  ('deepseek-v4-pro', 'azure_openai', 'DeepSeek-V4-Pro'),
  ('deepseek-v4-flash', 'azure_openai', 'DeepSeek-V4-Flash'),
  -- No fireworks lane for the undated base: their only DeepSeek V4 Flash
  -- registration is the dated -0731 build, which is its own catalog model
  -- below (a pinned build is not the rolling base, and one wire id may not
  -- serve two models).
  ('deepseek-v4-flash-0731', 'azure_openai', 'DeepSeek-V4-Flash-0731'),
  ('deepseek-v4-flash-0731', 'fireworks', 'accounts/fireworks/models/deepseek-v4-flash-0731'),
  ('deepseek-v4-pro-0813', 'fireworks', 'accounts/fireworks/models/deepseek-v4-pro-0813'),
  ('mistral-medium-3-5', 'azure_openai', 'mistral-medium-3-5'),
  ('ministral-14b-2512', 'bedrock', 'mistral.ministral-3-14b-instruct'),
  ('nova-2-lite-v1', 'bedrock', 'us.amazon.nova-2-lite-v1:0'),
  ('nemotron-3.5-lightning', 'azure_openai', 'FW-Nemotron-Lightning-3.5-30B-A3B'),
  ('nemotron-3.5-lightning', 'fireworks', 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b'),
  ('nemotron-3-ultra-550b-a55b', 'azure_openai', 'FW-Nemotron-3-Ultra-NVFP4'),
  ('nemotron-3-ultra-550b-a55b', 'fireworks', 'accounts/fireworks/models/nemotron-3-ultra-nvfp4'),
  ('nemotron-3-nano-30b-a3b', 'bedrock', 'nvidia.nemotron-nano-3-30b'),
  ('nemotron-3-super-120b-a12b', 'bedrock', 'nvidia.nemotron-super-3-120b'),
  ('qwen3.7-plus', 'fireworks', 'accounts/fireworks/models/qwen3p7-plus'),
  ('qwen3.8-max', 'fireworks', 'accounts/fireworks/models/qwen3p8-max'),
  ('qwen3.8-2.4t-a95b', 'fireworks', 'accounts/fireworks/models/qwen3p8-2p4t-a95b')
) as v(slug, provider, provider_model_id)
join public.models m on m.slug = v.slug and m.owning_org_id is null
join lateral (
  select capabilities, input_micro_usd_per_million,
    cached_input_micro_usd_per_million, output_micro_usd_per_million, pricing_source
  from public.model_providers src
  where src.model_id = m.id and src.owning_org_id is null
  order by (src.provider = 'openrouter') desc, src.created_at, src.id
  limit 1
) src on true
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do update set
  billing_source = excluded.billing_source,
  input_micro_usd_per_million = excluded.input_micro_usd_per_million,
  cached_input_micro_usd_per_million = excluded.cached_input_micro_usd_per_million,
  output_micro_usd_per_million = excluded.output_micro_usd_per_million,
  pricing_source = excluded.pricing_source,
  capabilities = excluded.capabilities;

-- 9b. Rebuild each mapped model's public (org null) default waterfall to the
-- map's rung order (rung 0 = primary). Sections 4-6 seeded a single rung-0
-- OpenRouter/native chain; delete those public rungs for exactly the mapped
-- models, then insert the full ordered chain. Idempotent/re-runnable.
delete from public.model_waterfalls
where org_id is null
  and model_id in (
    select id from public.models where owning_org_id is null and slug in (
      'claude-fable-5', 'claude-haiku-4.5', 'claude-opus-4.8', 'claude-opus-5', 'claude-sonnet-5',
      'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
      'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash',
      'gemini-3.1-flash-lite', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image',
      'grok-4.3', 'grok-4.20-multi-agent', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2.7-code', 'kimi-k3',
      'glm-5.2', 'glm-5', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-pro-0813',
      'mistral-medium-3-5', 'ministral-14b-2512', 'nova-2-lite-v1',
      'nemotron-3.5-lightning', 'nemotron-3-ultra-550b-a55b', 'nemotron-3-nano-30b-a3b', 'nemotron-3-super-120b-a12b',
      'qwen3.7-plus', 'qwen3.8-max', 'qwen3.8-2.4t-a95b'
    )
  );

insert into public.model_waterfalls (model_id, position, model_provider_id)
select m.id, v.position, mp.id
from (values
  ('claude-fable-5', 0, 'anthropic', 'claude-fable-5'),
  ('claude-fable-5', 1, 'openrouter', 'anthropic/claude-fable-5'),
  ('claude-haiku-4.5', 0, 'anthropic', 'claude-haiku-4-5'),
  ('claude-haiku-4.5', 1, 'openrouter', 'anthropic/claude-haiku-4.5'),
  ('claude-opus-4.8', 0, 'anthropic', 'claude-opus-4-8'),
  ('claude-opus-4.8', 1, 'openrouter', 'anthropic/claude-opus-4.8'),
  ('claude-opus-5', 0, 'anthropic', 'claude-opus-5'),
  ('claude-opus-5', 1, 'openrouter', 'anthropic/claude-opus-5'),
  ('claude-sonnet-5', 0, 'anthropic', 'claude-sonnet-5'),
  ('claude-sonnet-5', 1, 'openrouter', 'anthropic/claude-sonnet-5'),
  ('gpt-5.5', 0, 'openai', 'gpt-5.5'),
  ('gpt-5.5', 1, 'openrouter', 'openai/gpt-5.5'),
  ('gpt-5.5-pro', 0, 'openai', 'gpt-5.5-pro'),
  ('gpt-5.5-pro', 1, 'openrouter', 'openai/gpt-5.5-pro'),
  ('gpt-5.6-luna', 0, 'openai', 'gpt-5.6-luna'),
  ('gpt-5.6-luna', 1, 'openrouter', 'openai/gpt-5.6-luna'),
  ('gpt-5.6-sol', 0, 'openai', 'gpt-5.6-sol'),
  ('gpt-5.6-sol', 1, 'openrouter', 'openai/gpt-5.6-sol'),
  ('gpt-5.6-terra', 0, 'openai', 'gpt-5.6-terra'),
  ('gpt-5.6-terra', 1, 'openrouter', 'openai/gpt-5.6-terra'),
  ('gemini-3.5-flash', 0, 'gemini', 'gemini-3.5-flash'),
  ('gemini-3.5-flash', 1, 'openrouter', 'google/gemini-3.5-flash'),
  ('gemini-3.5-flash-lite', 0, 'gemini', 'gemini-3.5-flash-lite'),
  ('gemini-3.5-flash-lite', 1, 'openrouter', 'google/gemini-3.5-flash-lite'),
  ('gemini-3.6-flash', 0, 'gemini', 'gemini-3.6-flash'),
  ('gemini-3.6-flash', 1, 'openrouter', 'google/gemini-3.6-flash'),
  ('gemini-3.7-flash', 0, 'gemini', 'gemini-3.7-flash'),
  ('gemini-3.7-flash', 1, 'openrouter', 'google/gemini-3.7-flash'),
  ('gemini-3.1-flash-lite', 0, 'gemini', 'gemini-3.1-flash-lite'),
  ('gemini-3.1-flash-lite', 1, 'openrouter', 'google/gemini-3.1-flash-lite'),
  ('gemini-3.1-flash-image', 0, 'gemini', 'gemini-3.1-flash-image'),
  ('gemini-3.1-flash-image', 1, 'openrouter', 'google/gemini-3.1-flash-image'),
  ('gemini-3.1-flash-lite-image', 0, 'gemini', 'gemini-3.1-flash-lite-image'),
  ('gemini-3.1-flash-lite-image', 1, 'openrouter', 'google/gemini-3.1-flash-lite-image'),
  ('gemini-3-pro-image', 0, 'gemini', 'gemini-3-pro-image'),
  ('gemini-3-pro-image', 1, 'openrouter', 'google/gemini-3-pro-image'),
  ('grok-4.3', 0, 'azure_openai', 'grok-4.3'),
  ('grok-4.3', 1, 'openrouter', 'x-ai/grok-4.3'),
  ('grok-4.20-multi-agent', 0, 'azure_openai', 'grok-4-20-reasoning'),
  ('grok-4.20-multi-agent', 1, 'openrouter', 'x-ai/grok-4.20-multi-agent'),
  ('kimi-k2.6', 0, 'azure_openai', 'Kimi-K2.6'),
  ('kimi-k2.6', 1, 'openrouter', 'moonshotai/kimi-k2.6'),
  ('kimi-k2.5', 0, 'azure_openai', 'Kimi-K2.5'),
  ('kimi-k2.5', 1, 'bedrock', 'moonshotai.kimi-k2.5'),
  ('kimi-k2.5', 2, 'openrouter', 'moonshotai/kimi-k2.5'),
  ('kimi-k2.7-code', 0, 'azure_openai', 'Kimi-K2.7-Code'),
  ('kimi-k2.7-code', 1, 'fireworks', 'accounts/fireworks/models/kimi-k2p7-code'),
  ('kimi-k2.7-code', 2, 'openrouter', 'moonshotai/kimi-k2.7-code'),
  ('kimi-k3', 0, 'azure_openai', 'FW-Kimi-K3'),
  ('kimi-k3', 1, 'fireworks', 'accounts/fireworks/models/kimi-k3'),
  ('kimi-k3', 2, 'openrouter', 'moonshotai/kimi-k3'),
  ('glm-5.2', 0, 'azure_openai', 'FW-GLM-5.2'),
  ('glm-5.2', 1, 'openrouter', 'z-ai/glm-5.2'),
  ('glm-5', 0, 'bedrock', 'zai.glm-5'),
  ('glm-5', 1, 'openrouter', 'z-ai/glm-5'),
  ('deepseek-v4-pro', 0, 'azure_openai', 'DeepSeek-V4-Pro'),
  ('deepseek-v4-pro', 1, 'openrouter', 'deepseek/deepseek-v4-pro'),
  ('deepseek-v4-flash', 0, 'azure_openai', 'DeepSeek-V4-Flash'),
  ('deepseek-v4-flash', 1, 'openrouter', 'deepseek/deepseek-v4-flash'),
  ('deepseek-v4-flash-0731', 0, 'azure_openai', 'DeepSeek-V4-Flash-0731'),
  ('deepseek-v4-flash-0731', 1, 'fireworks', 'accounts/fireworks/models/deepseek-v4-flash-0731'),
  ('deepseek-v4-flash-0731', 2, 'openrouter', 'deepseek/deepseek-v4-flash-0731'),
  ('deepseek-v4-pro-0813', 0, 'fireworks', 'accounts/fireworks/models/deepseek-v4-pro-0813'),
  ('deepseek-v4-pro-0813', 1, 'openrouter', 'deepseek/deepseek-v4-pro-0813'),
  ('mistral-medium-3-5', 0, 'azure_openai', 'mistral-medium-3-5'),
  ('mistral-medium-3-5', 1, 'openrouter', 'mistralai/mistral-medium-3-5'),
  ('ministral-14b-2512', 0, 'bedrock', 'mistral.ministral-3-14b-instruct'),
  ('ministral-14b-2512', 1, 'openrouter', 'mistralai/ministral-14b-2512'),
  ('nova-2-lite-v1', 0, 'bedrock', 'us.amazon.nova-2-lite-v1:0'),
  ('nova-2-lite-v1', 1, 'openrouter', 'amazon/nova-2-lite-v1'),
  ('nemotron-3.5-lightning', 0, 'azure_openai', 'FW-Nemotron-Lightning-3.5-30B-A3B'),
  ('nemotron-3.5-lightning', 1, 'fireworks', 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b'),
  ('nemotron-3.5-lightning', 2, 'openrouter', 'nvidia/nemotron-3.5-lightning'),
  ('nemotron-3-ultra-550b-a55b', 0, 'azure_openai', 'FW-Nemotron-3-Ultra-NVFP4'),
  ('nemotron-3-ultra-550b-a55b', 1, 'fireworks', 'accounts/fireworks/models/nemotron-3-ultra-nvfp4'),
  ('nemotron-3-ultra-550b-a55b', 2, 'openrouter', 'nvidia/nemotron-3-ultra-550b-a55b'),
  ('nemotron-3-nano-30b-a3b', 0, 'bedrock', 'nvidia.nemotron-nano-3-30b'),
  ('nemotron-3-nano-30b-a3b', 1, 'openrouter', 'nvidia/nemotron-3-nano-30b-a3b'),
  ('nemotron-3-super-120b-a12b', 0, 'bedrock', 'nvidia.nemotron-super-3-120b'),
  ('nemotron-3-super-120b-a12b', 1, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b'),
  ('qwen3.7-plus', 0, 'fireworks', 'accounts/fireworks/models/qwen3p7-plus'),
  ('qwen3.7-plus', 1, 'openrouter', 'qwen/qwen3.7-plus'),
  ('qwen3.8-max', 0, 'fireworks', 'accounts/fireworks/models/qwen3p8-max'),
  ('qwen3.8-max', 1, 'openrouter', 'qwen/qwen3.8-max'),
  ('qwen3.8-2.4t-a95b', 0, 'fireworks', 'accounts/fireworks/models/qwen3p8-2p4t-a95b'),
  ('qwen3.8-2.4t-a95b', 1, 'openrouter', 'qwen/qwen3.8-2.4t-a95b')
) as v(slug, position, provider, provider_model_id)
join public.models m on m.slug = v.slug and m.owning_org_id is null
join public.model_providers mp
  on mp.model_id = m.id and mp.provider = v.provider
  and mp.provider_model_id = v.provider_model_id and mp.owning_org_id is null
on conflict (model_id, org_id, position) do update set
  model_provider_id = excluded.model_provider_id;

-- Experiential Cloud catalog rows for the two public aliases. Rows are
-- public and host_managed. Customer list
-- prices are 80% of the OpenRouter public market rates retrieved
-- 2026-08-22 from GET https://openrouter.ai/api/v1/models (20% off).
-- Non-integral 4/5 results fail closed except the one opted-in floor on
-- DeepSeek cached input (10612 * 4/5 = 8489.6 -> 8489). Qwen and the other
-- DeepSeek fields convert exactly. Production is migration-only: the
-- matching UPDATE is 20260830010000_experiential_cloud_list_prices.sql
-- (seed-owned rows only: public, canonical provider_model_id, base_url
-- IS NULL). This seed covers fresh and reseeded environments:
--   deepseek/deepseek-v4-flash  53060 / 10612 cache / 106120  -> 42448 / 8489 / 84896
--   qwen/qwen3.8-27b            400000 / 50000 cache / 3000000 -> 320000 / 40000 / 2400000
-- The worker origin is NOT stored here (the production URL is a cutover
-- decision). Catalog build skips these rows until
-- EXPLABS_EXPERIENTIAL_CLOUD_BASE_URL is set. Waterfall rungs are appended
-- after existing positions so a re-seed does not overwrite Azure / Fireworks
-- / OpenRouter. Missing deployments receive distinct positions within each
-- model, and a re-run skips deployments already on the public chain.
insert into public.model_providers (
  model_id,
  provider,
  provider_model_id,
  billing_source,
  input_micro_usd_per_million,
  cached_input_micro_usd_per_million,
  output_micro_usd_per_million,
  pricing_source,
  pricing_effective_at,
  capabilities
)
select
  models.id,
  'experiential_cloud',
  prices.provider_model_id,
  'host_managed',
  prices.input_micro,
  prices.cached_micro,
  prices.output_micro,
  prices.pricing_source,
  '2026-08-22T00:00:00+00:00'::timestamptz,
  '{"supports_streaming": true, "supports_structured_text": true, "supports_stop_sequences": true}'::jsonb
from (
  values
    (
      'deepseek-v4-flash',
      'deepseek-v4-flash',
      42448::bigint,
      8489::bigint,
      84896::bigint,
      'openrouter:deepseek/deepseek-v4-flash@2026-08-22*0.8'
    ),
    (
      'qwen3.8-27b',
      'qwen3.8-27b',
      320000::bigint,
      40000::bigint,
      2400000::bigint,
      'openrouter:qwen/qwen3.8-27b@2026-08-22*0.8'
    )
) as prices(
  slug, provider_model_id, input_micro, cached_micro, output_micro, pricing_source
)
join public.models models
  on models.slug = prices.slug and models.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do update set
  billing_source = excluded.billing_source,
  input_micro_usd_per_million = excluded.input_micro_usd_per_million,
  cached_input_micro_usd_per_million = excluded.cached_input_micro_usd_per_million,
  output_micro_usd_per_million = excluded.output_micro_usd_per_million,
  pricing_source = excluded.pricing_source,
  pricing_effective_at = excluded.pricing_effective_at,
  capabilities = excluded.capabilities;

with missing_deployments as (
  select
    deployments.id,
    deployments.model_id,
    row_number() over (
      partition by deployments.model_id
      order by deployments.created_at, deployments.id
    ) as position_offset
  from public.model_providers deployments
  where deployments.provider = 'experiential_cloud'
    and deployments.owning_org_id is null
    and not exists (
      select 1
      from public.model_waterfalls existing
      where existing.model_id = deployments.model_id
        and existing.org_id is null
        and existing.model_provider_id = deployments.id
    )
), chain_maxima as (
  select
    missing.model_id,
    coalesce(max(rungs.position), -1) as max_position
  from missing_deployments missing
  left join public.model_waterfalls rungs
    on rungs.model_id = missing.model_id
    and rungs.org_id is null
  group by missing.model_id
)
insert into public.model_waterfalls (model_id, position, model_provider_id)
select
  missing.model_id,
  maxima.max_position + missing.position_offset::integer,
  missing.id
from missing_deployments missing
join chain_maxima maxima on maxima.model_id = missing.model_id;

-- Experiential Cloud leads every default chain it serves on (owner decision
-- 2026-08-24): renumber each default chain carrying an experiential_cloud
-- rung so those rungs come first, preserving relative order within each
-- group. Scoped to chains not already EC-first so a re-seed leaves settled
-- rows untouched (updated_at stays honest); org-scoped overrides are a
-- tenant's explicit order and are never renumbered. Two phases because the
-- (model_id, org_id, position) key is checked per row: park the chain far
-- above its range, then write the final 0..n-1.
with out_of_order as (
  select w.model_id
  from public.model_waterfalls w
  join public.model_providers mp on mp.id = w.model_provider_id
  where w.org_id is null
  group by w.model_id
  having bool_or(mp.provider = 'experiential_cloud')
     and min(w.position) filter (where mp.provider <> 'experiential_cloud')
         < max(w.position) filter (where mp.provider = 'experiential_cloud')
)
update public.model_waterfalls w
   set position = w.position + 1000000
 where w.org_id is null
   and w.model_id in (select model_id from out_of_order);

with ranked as (
  select w.id,
         row_number() over (
           partition by w.model_id
           order by (mp.provider <> 'experiential_cloud'), w.position, w.id
         ) - 1 as new_position
  from public.model_waterfalls w
  join public.model_providers mp on mp.id = w.model_provider_id
  where w.org_id is null
    and w.position >= 1000000
)
update public.model_waterfalls w
   set position = ranked.new_position
  from ranked
 where ranked.id = w.id;

-- ---------------------------------------------------------------------------
-- Promotions (v2: scoped). Seeds the launch set: three FREE tiers (Qwen3.8
-- 27B $10, DeepSeek V4 Flash $10, GPT-5.6 Luna $20 -- per-org, lifetime) and
-- the "GPT on Experiential Cloud - 50% off" promotion (owner decision
-- 2026-08-24: model scope = exactly gpt-5.6-luna/sol/terra by explicit
-- membership, audience = orgs carrying the 'yc' label only; lane scope =
-- experiential_cloud, so the discount applies only to requests SERVED through
-- Experiential Cloud; per-org charged-spend ceiling $50,000, lifetime). The
-- gateway enforces caps and audience at the reservation seam; the catalog
-- reads the display projection. Cap micro-USD: $1 = 1_000_000.
--
-- ADMIN-SAFE: promotions are admin-managed (Admin -> Promotions), so a
-- re-seed must NOT clobber an operator's edits. Keyed on label with ON
-- CONFLICT DO NOTHING, and membership rows are written only for promotions
-- this run just created (the CTE returns nothing for pre-existing labels), so
-- an operator's scope edits survive re-seeding too.
with seeded as (
  insert into public.model_promotions (
    label, per_org_cap_micro_usd, discount_cap_micro_usd, cap_scope,
    percent_off, providers, family_keys, audience_labels, active, display_order
  ) values
    ('qwen3.8-27b', 10000000, 0, 'lifetime', 0, '{}', '{}', '{}', true, 0),
    ('deepseek-v4-flash', 10000000, 0, 'lifetime', 0, '{}', '{}', '{}', true, 1),
    ('gpt-5.6-luna', 20000000, 0, 'lifetime', 0, '{}', '{}', '{}', true, 2),
    ('GPT on Experiential Cloud - 50% off', 0, 50000000000, 'lifetime', 50,
     array['experiential_cloud'], '{}', array['yc'], true, 3)
  on conflict (label) do nothing
  returning id, label
)
insert into public.model_promotion_models (promotion_id, model_id, slug)
select seeded.id, models.id, models.slug
  from seeded
  join public.models
    on models.owning_org_id is null
   and (
     (seeded.label in ('qwen3.8-27b', 'deepseek-v4-flash', 'gpt-5.6-luna')
      and models.slug = seeded.label)
     or (seeded.label = 'GPT on Experiential Cloud - 50% off'
         and models.slug in ('gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'))
   )
on conflict (promotion_id, model_id) do nothing;

-- Repair migrated placeholder rows (v1's fill-cap-when-0 semantics): a v1
-- display placeholder carried cap 0 / percent 0 and relied on the seed to
-- fill its free cap. Fill it ONLY while every term is still unset, so an
-- operator's edits always win over a re-seed.
update public.model_promotions promos
   set per_org_cap_micro_usd = repair.cap_micro_usd
  from (values
    ('qwen3.8-27b', 10000000::bigint),
    ('deepseek-v4-flash', 10000000::bigint),
    ('gpt-5.6-luna', 20000000::bigint)
  ) as repair(label, cap_micro_usd)
 where promos.label = repair.label
   and promos.per_org_cap_micro_usd = 0
   and promos.percent_off = 0
   and promos.discount_cap_micro_usd = 0;

-- 10. OpenRouter-driven metadata backfill (r3: filled from OpenRouter's own
-- listing). Pulled live from GET
-- https://openrouter.ai/api/v1/models (2026-08-22). Every OpenRouter-routed
-- catalog wire id maps 1:1 to a live OR entry, so input/output/cached prices,
-- context window, input modalities, and release date are refreshed here from
-- OR's real values (this section is the authoritative last-writer for those
-- fields on the OpenRouter lane). Cross-provider native rows (Azure/Bedrock/
-- Fireworks/first-party) that only BORROWED the OpenRouter price in section 9a
-- are relabeled pricing_source='estimate' — we have no authoritative per-provider
-- price for them yet; the estimate->measured design (docs/models) promotes them
-- once we serve enough volume. Idempotent and re-runnable.
drop table if exists or_backfill;
create temporary table or_backfill (
  wire text primary key,
  input_micro bigint,
  cached_micro bigint,
  output_micro bigint,
  ctx integer,
  mods text[],
  release_date date
);
insert into or_backfill (wire, input_micro, cached_micro, output_micro, ctx, mods, release_date) values
  ('amazon/nova-2-lite-v1', 300000::bigint, null::bigint, 2500000::bigint, 1000000::integer, '{text,image,video,pdf}'::text[], '2025-12-02'::date),
  ('anthropic/claude-fable-5', 10000000::bigint, 1000000::bigint, 50000000::bigint, 1000000::integer, '{text,image,pdf}'::text[], '2026-06-09'::date),
  ('anthropic/claude-haiku-4.5', 1000000::bigint, 100000::bigint, 5000000::bigint, 200000::integer, '{text,image,pdf}'::text[], '2025-10-15'::date),
  ('anthropic/claude-opus-4.7-fast', 30000000::bigint, 3000000::bigint, 150000000::bigint, 1000000::integer, '{text,image,pdf}'::text[], '2026-05-12'::date),
  ('anthropic/claude-opus-4.8', 5000000::bigint, 500000::bigint, 25000000::bigint, 1000000::integer, '{text,image,pdf}'::text[], '2026-05-27'::date),
  ('anthropic/claude-opus-4.8-fast', 10000000::bigint, 1000000::bigint, 50000000::bigint, 1000000::integer, '{text,image,pdf}'::text[], '2026-05-27'::date),
  ('anthropic/claude-opus-5', 5000000::bigint, 500000::bigint, 25000000::bigint, 1000000::integer, '{text,image,pdf}'::text[], '2026-07-24'::date),
  ('anthropic/claude-opus-5-fast', 10000000::bigint, 1000000::bigint, 50000000::bigint, 1000000::integer, '{text,image,pdf}'::text[], '2026-07-24'::date),
  ('anthropic/claude-sonnet-5', 2000000::bigint, 200000::bigint, 10000000::bigint, 1000000::integer, '{text,image,pdf}'::text[], '2026-06-30'::date),
  ('bytedance-seed/seed-2-1-turbo', 500000::bigint, null::bigint, 2500000::bigint, 262144::integer, '{text,image,video}'::text[], '2026-08-12'::date),
  ('bytedance-seed/seed-2.0-code', 500000::bigint, null::bigint, 3000000::bigint, 262144::integer, '{text,image,video}'::text[], '2026-08-12'::date),
  ('deepseek/deepseek-v4-flash', 60060::bigint, 12012::bigint, 120120::bigint, 1048576::integer, '{text}'::text[], '2026-04-24'::date),
  ('deepseek/deepseek-v4-flash-0731', 80000::bigint, 16000::bigint, 180000::bigint, 1310720::integer, '{text}'::text[], '2026-07-31'::date),
  ('deepseek/deepseek-v4-pro', 413772::bigint, 34481::bigint, 827544::bigint, 1048576::integer, '{text}'::text[], '2026-04-24'::date),
  ('deepseek/deepseek-v4-pro-0813', 1188000::bigint, 39600::bigint, 3564000::bigint, 1048576::integer, '{text}'::text[], '2026-08-12'::date),
  ('google/gemini-3-pro-image', 2000000::bigint, 200000::bigint, 12000000::bigint, 131072::integer, '{text,image}'::text[], '2026-06-18'::date),
  ('google/gemini-3.1-flash-image', 500000::bigint, null::bigint, 3000000::bigint, 131072::integer, '{text,image}'::text[], '2026-06-18'::date),
  ('google/gemini-3.1-flash-lite', 250000::bigint, 25000::bigint, 1500000::bigint, 1048576::integer, '{text,image,video,pdf,audio}'::text[], '2026-05-07'::date),
  ('google/gemini-3.1-flash-lite-image', 250000::bigint, null::bigint, 1500000::bigint, 65536::integer, '{text,image}'::text[], '2026-06-30'::date),
  ('google/gemini-3.5-flash', 1500000::bigint, 150000::bigint, 9000000::bigint, 1048576::integer, '{text,image,video,pdf,audio}'::text[], '2026-05-19'::date),
  ('google/gemini-3.5-flash-lite', 300000::bigint, 30000::bigint, 2500000::bigint, 1048576::integer, '{text,image,video,pdf,audio}'::text[], '2026-07-21'::date),
  ('google/gemini-3.6-flash', 750000::bigint, 75000::bigint, 3750000::bigint, 1048576::integer, '{text,image,video,pdf,audio}'::text[], '2026-07-21'::date),
  ('google/gemini-3.7-flash', 375000::bigint, 37500::bigint, 1875000::bigint, 1048576::integer, '{text,image,video,pdf,audio}'::text[], '2026-08-13'::date),
  ('mistralai/ministral-14b-2512', 200000::bigint, 20000::bigint, 200000::bigint, 262144::integer, '{text,image}'::text[], '2025-12-02'::date),
  ('mistralai/mistral-medium-3-5', 1500000::bigint, null::bigint, 7500000::bigint, 262144::integer, '{text,image,pdf}'::text[], '2026-04-30'::date),
  ('mistralai/mistral-small-2603', 150000::bigint, 15000::bigint, 600000::bigint, 262144::integer, '{text,image}'::text[], '2026-03-16'::date),
  ('moonshotai/kimi-k2.5', 450000::bigint, 70000::bigint, 2250000::bigint, 262144::integer, '{text,image}'::text[], '2026-01-27'::date),
  ('moonshotai/kimi-k2.6', 541500::bigint, 91200::bigint, 2280000::bigint, 262144::integer, '{text,image}'::text[], '2026-04-20'::date),
  ('moonshotai/kimi-k2.7-code', 670000::bigint, 170000::bigint, 3400000::bigint, 262144::integer, '{text,image}'::text[], '2026-06-12'::date),
  ('moonshotai/kimi-k3', 3000000::bigint, 300000::bigint, 15000000::bigint, 1048576::integer, '{text,image,video}'::text[], '2026-07-16'::date),
  ('nvidia/nemotron-3-nano-30b-a3b', 50000::bigint, 30000::bigint, 200000::bigint, 262144::integer, '{text}'::text[], '2025-12-14'::date),
  ('nvidia/nemotron-3-super-120b-a12b', 85000::bigint, null::bigint, 400000::bigint, 1000000::integer, '{text}'::text[], '2026-03-11'::date),
  ('nvidia/nemotron-3-ultra-550b-a55b', 600000::bigint, 200000::bigint, 3600000::bigint, 512288::integer, '{text}'::text[], '2026-06-04'::date),
  ('nvidia/nemotron-3.5-lightning', 80000::bigint, 40000::bigint, 200000::bigint, 262144::integer, '{text}'::text[], '2026-08-11'::date),
  ('openai/gpt-5.5', 5000000::bigint, 500000::bigint, 30000000::bigint, 1050000::integer, '{text,pdf,image}'::text[], '2026-04-24'::date),
  ('openai/gpt-5.5-pro', 30000000::bigint, null::bigint, 180000000::bigint, 1050000::integer, '{text,pdf,image}'::text[], '2026-04-24'::date),
  ('openai/gpt-5.6-luna', 200000::bigint, 20000::bigint, 1200000::bigint, 1050000::integer, '{text,pdf,image}'::text[], '2026-07-09'::date),
  ('openai/gpt-5.6-luna-pro', 200000::bigint, 20000::bigint, 1200000::bigint, 1050000::integer, '{text,pdf,image}'::text[], '2026-07-09'::date),
  ('openai/gpt-5.6-sol', 2000000::bigint, 200000::bigint, 10000000::bigint, 1050000::integer, '{text,pdf,image}'::text[], '2026-07-09'::date),
  ('openai/gpt-5.6-sol-pro', 2000000::bigint, 200000::bigint, 10000000::bigint, 1050000::integer, '{text,pdf,image}'::text[], '2026-07-09'::date),
  ('openai/gpt-5.6-terra', 2000000::bigint, 200000::bigint, 12000000::bigint, 1050000::integer, '{text,pdf,image}'::text[], '2026-07-09'::date),
  ('openai/gpt-5.6-terra-pro', 2000000::bigint, 200000::bigint, 12000000::bigint, 1050000::integer, '{text,pdf,image}'::text[], '2026-07-09'::date),
  ('openai/gpt-chat-latest', 5000000::bigint, 500000::bigint, 30000000::bigint, 400000::integer, '{text,image,pdf}'::text[], '2026-05-05'::date),
  ('qwen/qwen3.5-9b', 100000::bigint, null::bigint, 150000::bigint, 262144::integer, '{text,image,video}'::text[], '2026-03-10'::date),
  ('qwen/qwen3.6-27b', 600000::bigint, 120000::bigint, 3600000::bigint, 262144::integer, '{text,image,video}'::text[], '2026-04-27'::date),
  ('qwen/qwen3.7-flash', 30000::bigint, 6000::bigint, 130000::bigint, 1000000::integer, '{text,image,video}'::text[], '2026-07-27'::date),
  ('qwen/qwen3.7-max', 1475000::bigint, 295000::bigint, 4425000::bigint, 1000000::integer, '{text}'::text[], '2026-05-21'::date),
  ('qwen/qwen3.7-plus', 320000::bigint, 64000::bigint, 1280000::bigint, 1000000::integer, '{text,image}'::text[], '2026-06-03'::date),
  ('qwen/qwen3.8-2.4t-a95b', 2000000::bigint, 250000::bigint, 6000000::bigint, 1048576::integer, '{text}'::text[], '2026-08-12'::date),
  ('qwen/qwen3.8-27b', 450000::bigint, 50000::bigint, 3200000::bigint, 1000000::integer, '{text,image,video}'::text[], '2026-08-14'::date),
  ('qwen/qwen3.8-max', 2000000::bigint, 250000::bigint, 6000000::bigint, 1000000::integer, '{text,image,video}'::text[], '2026-08-03'::date),
  ('sakana/sakana-namazu', 950000::bigint, 150000::bigint, 4000000::bigint, 262144::integer, '{text,image,pdf}'::text[], '2026-08-11'::date),
  ('stealth/ox-alpha', 0::bigint, null::bigint, 0::bigint, 1048576::integer, '{text,image,video}'::text[], '2026-08-20'::date),
  ('thinkingmachines/inkling', 950000::bigint, 160000::bigint, 4050000::bigint, 1048576::integer, '{text,image,audio}'::text[], '2026-07-17'::date),
  ('thinkingmachines/inkling-small', 450000::bigint, 100000::bigint, 1200000::bigint, 1048576::integer, '{text,image,audio}'::text[], '2026-07-30'::date),
  ('upstage/solar-pro4', 30000::bigint, 6000::bigint, 120000::bigint, 524288::integer, '{text}'::text[], '2026-08-10'::date),
  ('x-ai/grok-4.20-multi-agent', 1250000::bigint, 200000::bigint, 2500000::bigint, 2000000::integer, '{text,image,pdf}'::text[], '2026-03-31'::date),
  ('x-ai/grok-4.3', 1250000::bigint, 200000::bigint, 2500000::bigint, 1000000::integer, '{text,image,pdf}'::text[], '2026-04-30'::date),
  ('x-ai/grok-4.5', 2000000::bigint, 300000::bigint, 6000000::bigint, 500000::integer, '{text,image,pdf}'::text[], '2026-07-08'::date),
  ('x-ai/grok-4.6', 2000000::bigint, 500000::bigint, 6000000::bigint, 500000::integer, '{text,image,pdf}'::text[], '2026-08-12'::date),
  ('x-ai/grok-build-0.1', 1000000::bigint, 200000::bigint, 2000000::bigint, 256000::integer, '{text,image,pdf}'::text[], '2026-05-20'::date),
  ('z-ai/glm-5', 600000::bigint, 120000::bigint, 1920000::bigint, 204800::integer, '{text}'::text[], '2026-02-11'::date),
  ('z-ai/glm-5-turbo', 1200000::bigint, 240000::bigint, 4000000::bigint, 202752::integer, '{text}'::text[], '2026-03-15'::date),
  ('z-ai/glm-5.1', 966000::bigint, 179400::bigint, 3036000::bigint, 204800::integer, '{text}'::text[], '2026-04-07'::date),
  ('z-ai/glm-5.2', 966000::bigint, 193200::bigint, 3036000::bigint, 1048576::integer, '{text}'::text[], '2026-06-16'::date),
  ('z-ai/glm-5.3', 1400000::bigint, 260000::bigint, 4400000::bigint, 1048576::integer, '{text}'::text[], '2026-08-18'::date),
  ('z-ai/glm-5v-turbo', 1200000::bigint, 240000::bigint, 4000000::bigint, 202752::integer, '{text,image,video}'::text[], '2026-04-01'::date)
;

-- 10a. Refresh the OpenRouter provider rows with OR's live prices.
update public.model_providers mp set
  input_micro_usd_per_million = b.input_micro,
  cached_input_micro_usd_per_million = b.cached_micro,
  output_micro_usd_per_million = b.output_micro,
  pricing_source = 'openrouter',
  pricing_effective_at = now()
from or_backfill b
where mp.owning_org_id is null
  and mp.provider = 'openrouter'
  and mp.provider_model_id = b.wire;

-- 10b. Refresh each model's context window, input modalities, and release date
-- from its OpenRouter entry (OR is the source of truth for these).
update public.models m set
  context_window = b.ctx,
  input_modalities = b.mods,
  release_date = coalesce(b.release_date, m.release_date)
from public.model_providers mp
join or_backfill b on b.wire = mp.provider_model_id
where mp.model_id = m.id
  and mp.provider = 'openrouter'
  and mp.owning_org_id is null
  and m.owning_org_id is null
  and b.ctx is not null;

-- 10c. Honesty pass: a native cross-provider row that merely borrowed the
-- OpenRouter price (section 9a) is an estimate, not that provider's real price.
-- Relabel the source so the UI shows "estimated"; the price value is kept as the
-- current best guess and the row keeps serving exactly as before.
update public.model_providers mp set pricing_source = 'estimate'
where mp.owning_org_id is null
  and mp.provider not in ('openrouter', 'experiential_cloud', 'local', 'modal')
  and mp.pricing_source = 'openrouter';

-- 10d. Estimate-fill EVERY missing serving stat (uptime, tok/s, latency) so no
-- provider row renders a blank cell (r2: "fill tok/s + the rest").
-- Conservative placeholders, not measured numbers: 99.0% uptime, 60 tok/s,
-- 900 ms p50. A row that had NO stats at all is stamped stats_source='estimate';
-- a row that already carried OpenRouter-seeded stats keeps that label (both
-- labels read as "estimated" in the UI). The observed overlay replaces all three
-- with measured values once the route clears the sample floor — the
-- estimate->measured flip is untouched.
update public.model_providers mp set
  uptime_30d = coalesce(mp.uptime_30d, 99.0),
  throughput_tps = coalesce(mp.throughput_tps, 60.0),
  latency_p50_ms = coalesce(mp.latency_p50_ms, 900.0),
  stats_source = coalesce(mp.stats_source, 'estimate')
where mp.owning_org_id is null
  and (mp.uptime_30d is null or mp.throughput_tps is null or mp.latency_p50_ms is null);

drop table if exists or_backfill;

-- 10e. Per-LANE price estimates (mirrors migration 20260830200000 for freshly
-- seeded environments): every unpriced public lane gets a sibling-derived or
-- catalog-median price, marked pricing_source='estimate'. Serving is untouched:
-- statuses are not modified, and the sync's activation gate refuses to turn a
-- host-managed lane on while its price source is 'estimate'.
-- 1. Sibling reference.
update public.model_providers mp
set input_micro_usd_per_million = src.input_micro,
    cached_input_micro_usd_per_million = src.cached_micro,
    output_micro_usd_per_million = src.output_micro,
    pricing_source = 'estimate',
    pricing_effective_at = now()
from (
  select distinct on (sibling.model_id)
    sibling.model_id,
    sibling.input_micro_usd_per_million as input_micro,
    sibling.cached_input_micro_usd_per_million as cached_micro,
    sibling.output_micro_usd_per_million as output_micro
  from public.model_providers sibling
  where sibling.owning_org_id is null
    and sibling.input_micro_usd_per_million is not null
    and sibling.output_micro_usd_per_million is not null
    and (sibling.pricing_source is null or sibling.pricing_source <> 'estimate')
  order by sibling.model_id,
    (sibling.provider = 'openrouter') desc,
    (sibling.pricing_source in ('openrouter', 'provider-docs', 'aws-price-list')) desc,
    sibling.created_at,
    sibling.id
) src
where mp.model_id = src.model_id
  and mp.owning_org_id is null
  and (mp.input_micro_usd_per_million is null or mp.output_micro_usd_per_million is null);

-- 2. Catalog-median fallback for models with no priced lane to reference.
update public.model_providers mp
set input_micro_usd_per_million = medians.input_micro,
    output_micro_usd_per_million = medians.output_micro,
    pricing_source = 'estimate',
    pricing_effective_at = now()
from (
  select
    (percentile_cont(0.5) within group (
       order by priced.input_micro_usd_per_million))::bigint as input_micro,
    (percentile_cont(0.5) within group (
       order by priced.output_micro_usd_per_million))::bigint as output_micro
  from public.model_providers priced
  where priced.owning_org_id is null
    and priced.input_micro_usd_per_million is not null
    and priced.output_micro_usd_per_million is not null
    and (priced.pricing_source is null or priced.pricing_source <> 'estimate')
) medians
where mp.owning_org_id is null
  and (mp.input_micro_usd_per_million is null or mp.output_micro_usd_per_million is null)
  and medians.input_micro is not null
  and medians.output_micro is not null;

-- 11. Catalog-sync additions. NEW canonical models are appended between the
-- markers below, each as an idempotent upsert (models row + its discovered
-- provider lane). Do not edit the marker lines; hand-curated models belong in
-- the sections above.
-- BEGIN DAILY-SYNC MODELS
-- daily sync 2026-08-23
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', '2026-08-21', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp', '2026-08-21', 1048576, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hy-mt2-1.8b', 'Hy-MT2-1.8B', '2026-08-20', 8192, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hy-mt2-30b-a3b', 'Hy-MT2-30B-A3B', '2026-08-20', 8192, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('glm-latest', 'GLM Latest', '2026-08-19', 1048576, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hy-mt2-7b', 'Hy-MT2-7B', '2026-08-19', 8192, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('dots-3-note-preview-free', 'Dots3-Note Preview (free)', '2026-08-14', 512000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.7-flash-batch', 'Gemini 3.7 Flash (batch)', '2026-08-13', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('lfm-2.5-2.6b-free', 'LFM2.5-2.6B (free)', '2026-08-11', 65536, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning (free)', '2026-08-11', 1000000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('muse-spark-1.2', 'Muse Spark 1.2', '2026-08-05', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('deepseek-v4-flash-latest', 'DeepSeek V4 Flash Latest', '2026-08-01', 1310720, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('inkling-small-free', 'Inkling Small (free)', '2026-07-30', 262144, '{text,image,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-opus-5-batch', 'Claude Opus 5 (batch)', '2026-07-24', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('ling-3.0-flash', 'Ling 3.0 Flash', '2026-07-23', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('laguna-s-2.1', 'Laguna S 2.1', '2026-07-21', 1048576, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('laguna-s-2.1-free', 'Laguna S 2.1 (free)', '2026-07-21', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.6-flash-batch', 'Gemini 3.6 Flash (batch)', '2026-07-21', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.5-flash-lite-batch', 'Gemini 3.5 Flash Lite (batch)', '2026-07-21', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('longcat-2.0', 'LongCat 2.0', '2026-07-20', 1048756, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('inkling-batch', 'Inkling (batch)', '2026-07-17', 524288, '{text,image,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('inkling-free', 'Inkling (free)', '2026-07-17', 262144, '{text,image,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('muse-spark-1.1', 'Muse Spark 1.1', '2026-07-16', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('kat-coder-air-v2.5', 'KAT-Coder-Air V2.5', '2026-07-10', 256000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('kat-coder-pro-v2.5', 'KAT-Coder-Pro V2.5', '2026-07-10', 256000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.6-luna-pro-batch', 'GPT-5.6 Luna Pro (batch)', '2026-07-09', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.6-luna-batch', 'GPT-5.6 Luna (batch)', '2026-07-09', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.6-terra-pro-batch', 'GPT-5.6 Terra Pro (batch)', '2026-07-09', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.6-terra-batch', 'GPT-5.6 Terra (batch)', '2026-07-09', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.6-sol-pro-batch', 'GPT-5.6 Sol Pro (batch)', '2026-07-09', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.6-sol-batch', 'GPT-5.6 Sol (batch)', '2026-07-09', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('grok-latest', 'Grok Latest', '2026-07-08', 500000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('aion-3.0-mini', 'Aion 3.0 Mini', '2026-07-07', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('aion-3.0', 'Aion 3.0', '2026-07-07', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hy3', 'Hy3', '2026-07-06', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('laguna-xs-2.1', 'Laguna XS 2.1', '2026-07-02', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('laguna-xs-2.1-free', 'Laguna XS 2.1 (free)', '2026-07-02', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-sonnet-5-batch', 'Claude Sonnet 5 (batch)', '2026-06-30', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nex-n2-mini', 'Nex-N2-Mini', '2026-06-24', 262144, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('fugu-ultra', 'Fugu Ultra', '2026-06-24', 1000000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('north-mini-code-free', 'North Mini Code (free)', '2026-06-17', 256000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('glm-5.2-batch', 'GLM 5.2 (batch)', '2026-06-16', 1048575, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('glm-5.2-free', 'GLM 5.2 (free)', '2026-06-16', 256000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('kimi-k2.7-code-batch', 'Kimi K2.7 Code (batch)', '2026-06-12', 262144, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-fable-latest', 'Claude Fable Latest', '2026-06-09', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-fable-5-batch', 'Claude Fable 5 (batch)', '2026-06-09', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nex-n2-pro', 'Nex-N2-Pro', '2026-06-08', 262144, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nemotron-3.5-content-safety-free', 'Nemotron 3.5 Content Safety (free)', '2026-06-04', 128000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nemotron-3-ultra-550b-a55b-batch', 'Nemotron 3 Ultra 550B A55B (batch)', '2026-06-04', 512288, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nemotron-3-ultra-550b-a55b-free', 'Nemotron 3 Ultra 550B A55B (free)', '2026-06-04', 1000000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('minimax-m3-batch', 'MiniMax M3 (batch)', '2026-05-31', 524288, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-opus-4.8-batch', 'Claude Opus 4.8 (batch)', '2026-05-27', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.5-flash-batch', 'Gemini 3.5 Flash (batch)', '2026-05-19', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('perceptron-mk1', 'Perceptron Mk1', '2026-05-12', 32768, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('ring-2.6-1t', 'Ring 2.6 1T', '2026-05-08', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.1-flash-lite-batch', 'Gemini 3.1 Flash Lite (batch)', '2026-05-07', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('granite-4.1-8b', 'Granite 4.1 8B', '2026-04-30', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nemotron-3-nano-omni-30b-a3b-reasoning-free', 'Nemotron 3 Nano Omni 30B A3B Reasoning (free)', '2026-04-28', 256000, '{text,audio,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-haiku-latest', 'Claude Haiku Latest', '2026-04-27', 200000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-mini-latest', 'GPT Mini Latest', '2026-04-27', 400000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-pro-latest', 'Gemini Pro Latest', '2026-04-27', 1048576, '{audio,pdf,image,text,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('kimi-latest', 'Kimi Latest', '2026-04-27', 1048576, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-flash-latest', 'Gemini Flash Latest', '2026-04-27', 1048576, '{text,image,video,pdf,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-sonnet-latest', 'Claude Sonnet Latest', '2026-04-27', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-latest', 'GPT Latest', '2026-04-27', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3.5-plus-20260420', 'Qwen3.5 Plus 2026-04-20', '2026-04-27', 1000000, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3.6-flash', 'Qwen3.6 Flash', '2026-04-27', 1000000, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3.6-max-preview', 'Qwen3.6 Max Preview', '2026-04-27', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.5-pro-batch', 'GPT-5.5 Pro (batch)', '2026-04-24', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.5-batch', 'GPT-5.5 (batch)', '2026-04-24', 1050000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('ling-2.6-1t', 'Ling 2.6 1T', '2026-04-23', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hy3-preview', 'Hy3 Preview', '2026-04-22', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mimo-v2.5-pro', 'MiMo-V2.5-Pro', '2026-04-22', 1050000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mimo-v2.5', 'MiMo-V2.5', '2026-04-22', 1050000, '{text,audio,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.4-image-2', 'GPT-5.4 Image 2', '2026-04-21', 272000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('ling-2.6-flash', 'Ling 2.6 Flash', '2026-04-21', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-opus-latest', 'Claude Opus Latest', '2026-04-21', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-opus-4.7-batch', 'Claude Opus 4.7 (batch)', '2026-04-16', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemma-4-26b-a4b-it-free', 'Gemma 4 26B A4B IT (free)', '2026-04-03', 262144, '{image,text,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3.6-plus', 'Qwen3.6 Plus', '2026-04-02', 1000000, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('trinity-large-thinking', 'Trinity Large Thinking', '2026-04-01', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('grok-4.20', 'Grok 4.20', '2026-03-31', 2000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('lyria-3-pro-preview', 'Lyria 3 Pro Preview', '2026-03-30', 1048576, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('lyria-3-clip-preview', 'Lyria 3 Clip Preview', '2026-03-30', 1048576, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('kat-coder-pro-v2', 'KAT-Coder-Pro V2', '2026-03-27', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('reka-edge', 'Reka Edge', '2026-03-20', 16384, '{image,text,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.4-nano-batch', 'GPT-5.4 Nano Batch', '2026-03-17', 400000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.4-mini-batch', 'GPT-5.4 Mini Batch', '2026-03-17', 400000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('seed-2.0-lite', 'Seed 2.0 Lite', '2026-03-10', 262144, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.4-pro-batch', 'GPT-5.4 Pro Batch', '2026-03-05', 1050000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.4-batch', 'GPT-5.4 Batch', '2026-03-05', 1050000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mercury-2', 'Mercury 2', '2026-03-04', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('seed-2.0-mini', 'Seed 2.0 Mini', '2026-02-26', 262144, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3.5-flash-02-23', 'Qwen3.5 Flash 02-23', '2026-02-25', 1000000, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.1-pro-preview-customtools', 'Gemini 3.1 Pro Preview Custom Tools', '2026-02-25', 1048576, '{text,audio,image,video,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('aion-2.0', 'Aion 2.0', '2026-02-23', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', '2026-02-19', 1048576, '{audio,pdf,image,text,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.1-pro-preview-batch', 'Gemini 3.1 Pro Preview Batch', '2026-02-19', 1048576, '{audio,pdf,image,text,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-sonnet-4.6-batch', 'Claude Sonnet 4.6 Batch', '2026-02-17', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3.5-plus-02-15', 'Qwen3.5 Plus 2026-02-15', '2026-02-16', 1000000, '{text,image,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3-max-thinking', 'Qwen3 Max Thinking', '2026-02-09', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-opus-4.6-batch', 'Claude Opus 4.6 Batch', '2026-02-04', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('openrouter-free', 'Free Models Router', '2026-02-01', 200000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('solar-pro-3', 'Solar Pro 3', '2026-01-27', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('minimax-m2-her', 'MiniMax M2-her', '2026-01-23', 65536, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('seed-1.6-flash', 'Seed 1.6 Flash', '2025-12-23', 262144, '{image,text,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('seed-1.6', 'Seed 1.6', '2025-12-23', 262144, '{image,text,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3-flash-preview', 'Gemini 3 Flash Preview', '2025-12-17', 1048576, '{text,image,pdf,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3-flash-preview-batch', 'Gemini 3 Flash Preview Batch', '2025-12-17', 1048576, '{text,image,pdf,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.2-pro', 'GPT-5.2 Pro', '2025-12-10', 400000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.2-pro-batch', 'GPT-5.2 Pro Batch', '2025-12-10', 400000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.2-batch', 'GPT-5.2 Batch', '2025-12-10', 400000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('relace-search', 'Relace Search', '2025-12-08', 256000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('glm-4.6v', 'GLM 4.6V', '2025-12-08', 131072, '{image,text,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mistral-large-2512', 'Mistral Large 3 2512', '2025-12-01', 262144, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-opus-4.5-batch', 'Claude Opus 4.5 Batch', '2025-11-24', 200000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('olmo-3-32b-think', 'OLMo 3 32B Think', '2025-11-21', 65536, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5.1-batch', 'GPT-5.1 Batch', '2025-11-13', 400000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nova-premier-v1', 'Nova Premier 1.0', '2025-10-31', 1000000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('sonar-pro-search', 'Sonar Pro Search', '2025-10-30', 200000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('granite-4.0-h-micro', 'Granite 4.0 Micro', '2025-10-20', 131000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5-image-mini', 'GPT-5 Image Mini', '2025-10-16', 400000, '{pdf,image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-haiku-4.5-batch', 'Claude Haiku 4.5 Batch', '2025-10-15', 200000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5-image', 'GPT-5 Image', '2025-10-14', 400000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-flash-image', 'Gemini 2.5 Flash Image', '2025-10-07', 32768, '{image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5-pro-batch', 'GPT-5 Pro (Batch)', '2025-10-06', 400000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-sonnet-4.5-batch', 'Claude Sonnet 4.5 (Batch)', '2025-09-29', 1000000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('deepseek-v3.2-exp', 'DeepSeek V3.2 Exp', '2025-09-29', 163840, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('cydonia-24b-v4.1', 'Cydonia 24B V4.1', '2025-09-27', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('relace-apply-3', 'Relace Apply 3', '2025-09-26', 256000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3-max', 'Qwen3 Max', '2025-09-23', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3-coder-plus', 'Qwen3 Coder Plus', '2025-09-23', 1000000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5-codex-batch', 'GPT-5 Codex (Batch)', '2025-09-23', 400000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3-coder-flash', 'Qwen3 Coder Flash', '2025-09-17', 1000000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen-plus-2025-07-28', 'Qwen Plus 0728', '2025-09-08', 1000000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen-plus-2025-07-28-thinking', 'Qwen Plus 0728 (Thinking)', '2025-09-08', 1000000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('nemotron-nano-9b-v2-free', 'Nemotron Nano 9B V2 (Free)', '2025-09-05', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('kimi-k2-0905', 'Kimi K2 0905', '2025-09-04', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hermes-4-70b', 'Hermes 4 70B', '2025-08-26', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hermes-4-405b', 'Hermes 4 405B', '2025-08-26', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mistral-medium-3.1', 'Mistral Medium 3.1', '2025-08-13', 131072, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5-batch', 'GPT-5 (Batch)', '2025-08-07', 400000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5-mini-batch', 'GPT-5 Mini (Batch)', '2025-08-07', 400000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5-nano-batch', 'GPT-5 Nano (Batch)', '2025-08-07', 400000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-opus-4.1-batch', 'Claude Opus 4.1 (Batch)', '2025-08-05', 200000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('codestral-2508', 'Codestral 2508', '2025-08-01', 256000, '{text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('ui-tars-1.5-7b', 'UI-TARS 1.5 7B', '2025-07-22', 128000, '{image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite', '2025-07-22', 1048576, '{text,image,pdf,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-flash-lite-batch', 'Gemini 2.5 Flash Lite (Batch)', '2025-07-22', 1048576, '{text,image,pdf,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('dolphin-mistral-24b-venice-edition', 'Dolphin Mistral 24B Venice Edition', '2025-07-09', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hunyuan-a13b-instruct', 'Hunyuan A13B Instruct', '2025-07-08', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('morph-v3-large', 'Morph V3 Large', '2025-07-07', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('morph-v3-fast', 'Morph V3 Fast', '2025-07-07', 81920, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('ernie-4.5-vl-424b-a47b', 'ERNIE 4.5 VL 424B A47B', '2025-06-30', 123000, '{image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mistral-small-3.2-24b-instruct', 'Mistral Small 3.2 24B Instruct', '2025-06-20', 131072, '{image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('minimax-m1', 'MiniMax M1', '2025-06-17', 1000000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-flash', 'Gemini 2.5 Flash', '2025-06-17', 1048576, '{pdf,image,text,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-flash-batch', 'Gemini 2.5 Flash (Batch)', '2025-06-17', 1048576, '{pdf,image,text,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-pro', 'Gemini 2.5 Pro', '2025-06-17', 1048576, '{text,image,pdf,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-pro-batch', 'Gemini 2.5 Pro (Batch)', '2025-06-17', 1048576, '{text,image,pdf,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o3-pro-batch', 'o3 Pro (Batch)', '2025-06-10', 200000, '{text,pdf,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-pro-preview', 'Gemini 2.5 Pro Preview 06-05', '2025-06-05', 1048576, '{pdf,image,text,audio}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-opus-4', 'Claude Opus 4', '2025-05-22', 200000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-sonnet-4', 'Claude Sonnet 4', '2025-05-22', 1000000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mistral-medium-3', 'Mistral Medium 3', '2025-05-07', 131072, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-pro-preview-05-06', 'Gemini 2.5 Pro Preview 05-06', '2025-05-07', 1048576, '{text,image,pdf,audio,video}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('virtuoso-large', 'Virtuoso Large', '2025-05-05', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('llama-guard-4-12b', 'Llama Guard 4 12B', '2025-04-30', 1048576, '{image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o4-mini-high', 'o4 Mini High', '2025-04-16', 200000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o4-mini-high-batch', 'o4 Mini High (Batch)', '2025-04-16', 200000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o3-batch', 'o3 (Batch)', '2025-04-16', 200000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o4-mini-batch', 'o4 Mini (Batch)', '2025-04-16', 200000, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4.1-batch', 'GPT-4.1 (Batch)', '2025-04-14', 1047576, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4.1-mini-batch', 'GPT-4.1 Mini (Batch)', '2025-04-14', 1047576, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4.1-nano-batch', 'GPT-4.1 Nano (Batch)', '2025-04-14', 1047576, '{image,text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('llama-4-maverick', 'Llama 4 Maverick', '2025-04-05', 1048576, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('llama-4-scout', 'Llama 4 Scout', '2025-04-05', 1310720, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o1-pro-batch', 'o1 Pro (Batch)', '2025-03-19', 200000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mistral-small-3.1-24b-instruct', 'Mistral Small 3.1 24B Instruct', '2025-03-17', 128000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('command-a', 'Command A', '2025-03-13', 256000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('reka-flash-3', 'Reka Flash 3', '2025-03-12', 65536, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('skyfall-36b-v2', 'Skyfall 36B V2', '2025-03-10', 32768, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('sonar-reasoning-pro', 'Sonar Reasoning Pro', '2025-03-07', 128000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('sonar-pro', 'Sonar Pro', '2025-03-07', 200000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('sonar-deep-research', 'Sonar Deep Research', '2025-03-07', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mistral-saba', 'Mistral Saba', '2025-02-17', 32768, '{text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o3-mini-high', 'o3 Mini High', '2025-02-12', 200000, '{text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o3-mini-high-batch', 'o3 Mini High (Batch)', '2025-02-12', 200000, '{text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('aion-rp-llama-3.1-8b', 'Aion-RP 1.0 (8B)', '2025-02-04', 32768, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen2.5-vl-72b-instruct', 'Qwen2.5 VL 72B Instruct', '2025-02-01', 128000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen-plus', 'Qwen Plus', '2025-02-01', 1000000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o3-mini-batch', 'o3 Mini (Batch)', '2025-01-31', 200000, '{text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('sonar', 'Sonar', '2025-01-27', 127072, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('minimax-01', 'MiniMax-01', '2025-01-15', 1000192, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('phi-4', 'Phi-4', '2025-01-10', 16384, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('llama-3.3-euryale-70b', 'Llama 3.3 Euryale 70B', '2024-12-18', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o1-batch', 'o1 (Batch)', '2024-12-17', 200000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('command-r7b-12-2024', 'Command R7B (12-2024)', '2024-12-14', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct', '2024-12-06', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('unslopnemo-12b', 'UnslopNemo 12B', '2024-11-08', 1024000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('magnum-v4-72b', 'Magnum V4 72B', '2024-10-22', 32768, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('ministral-8b', 'Ministral 8B', '2024-10-17', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('rocinante-12b', 'Rocinante 12B', '2024-09-30', 65536, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('command-r-08-2024', 'Command R (08-2024)', '2024-08-30', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('command-r-plus-08-2024', 'Command R+ (08-2024)', '2024-08-30', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('llama-3.1-euryale-70b', 'Llama 3.1 Euryale 70B V2.2', '2024-08-28', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hermes-3-llama-3.1-70b', 'Hermes 3 Llama 3.1 70B', '2024-08-18', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('hermes-3-llama-3.1-405b', 'Hermes 3 Llama 3.1 405B', '2024-08-16', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('llama-3-lunaris-8b', 'Llama 3 Lunaris 8B', '2024-08-13', 8192, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('llama-3.1-70b-instruct', 'Llama 3.1 70B Instruct', '2024-07-23', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mistral-nemo', 'Mistral Nemo', '2024-07-19', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4o-mini-batch', 'GPT-4o Mini (Batch)', '2024-07-18', 128000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemma-2-27b-it', 'Gemma 2 27B IT', '2024-07-13', 8192, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4o-batch', 'GPT-4o (Batch)', '2024-05-13', 128000, '{text,image,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mixtral-8x22b-instruct', 'Mixtral 8x22B Instruct', '2024-04-17', 65536, '{text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('wizardlm-2-8x22b', 'WizardLM-2 8x22B', '2024-04-16', 65535, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4-turbo-batch', 'GPT-4 Turbo (Batch)', '2024-04-09', 128000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('claude-3-haiku', 'Claude 3 Haiku', '2024-03-13', 200000, '{text,image}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('mistral-large', 'Mistral Large', '2024-02-26', 128000, '{text,pdf}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-3.5-turbo-0613', 'GPT-3.5 Turbo 0613', '2024-01-25', 4095, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4-turbo-preview', 'GPT-4 Turbo Preview', '2024-01-25', 128000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-3.5-turbo-instruct', 'GPT-3.5 Turbo Instruct', '2023-09-28', 4095, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-3.5-turbo-16k', 'GPT-3.5 Turbo 16K', '2023-08-28', 16385, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('weaver', 'Weaver (Alpha)', '2023-08-02', 8000, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('remm-slerp-l2-13b', 'ReMM SLERP 13B', '2023-07-22', 6144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-3.5-turbo', 'GPT-3.5 Turbo', '2023-05-28', 16385, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-3.5-turbo-batch', 'GPT-3.5 Turbo (Batch)', '2023-05-28', 16385, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4', 'GPT-4', '2023-05-28', 8191, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('davinci-002', 'Davinci 002', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('babbage-002', 'Babbage 002', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-3.5-turbo-instruct-0914', 'GPT-3.5 Turbo Instruct 0914', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-3.5-turbo-1106', 'GPT-3.5 Turbo 1106', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('tts-1-hd', 'TTS-1 HD', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('tts-1-1106', 'TTS-1 1106', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('tts-1-hd-1106', 'TTS-1 HD 1106', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('text-embedding-3-small', 'Text Embedding 3 Small', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('text-embedding-3-large', 'Text Embedding 3 Large', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-3.5-turbo-0125', 'GPT-3.5 Turbo 0125', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('omni-moderation', 'Omni Moderation', '2024-09-26', null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4o-mini-search-preview', 'GPT-4o Mini Search Preview', '2025-03-11', null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('o4-mini-deep-research', 'o4-mini Deep Research', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-5-search-api', 'GPT-5 Search API', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('sora-2-pro', 'Sora 2 Pro', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('chatgpt-image-latest', 'ChatGPT Image Latest', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gpt-4o-search-preview', 'GPT-4o Search Preview', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('tts-1', 'TTS-1', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('whisper-1', 'Whisper 1', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('text-embedding-ada-002', 'Text Embedding Ada 002', null, null, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash Preview TTS', null, 8192, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-pro-preview-tts', 'Gemini 2.5 Pro Preview TTS', null, 8192, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-flash-lite-latest', 'Gemini Flash-Lite Latest', null, 1048576, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-omni-flash-preview', 'Gemini Omni Flash Preview', null, 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-3.1-flash-tts-preview', 'Gemini 3.1 Flash TTS Preview', null, 8192, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-robotics-er-1.6-preview', 'Gemini Robotics-ER 1.6 Preview', null, 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-robotics-er-2-preview', 'Gemini Robotics-ER 2 Preview', null, 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemini-2.5-computer-use-preview-10-2025', 'Gemini 2.5 Computer Use Preview 10-2025', '2025-10-01', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('antigravity-preview-05-2026', 'Antigravity Agent Preview', '2026-05-01', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('deep-research-max-preview-04-2026', 'Deep Research Max Preview (Apr-21-2026)', '2026-04-21', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('deep-research-preview-04-2026', 'Deep Research Preview (Apr-21-2026)', '2026-04-21', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('deep-research-pro-preview-12-2025', 'Deep Research Pro Preview (Dec-12-2025)', '2025-12-12', 131072, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meta/muse-spark-1.2-contributor', 'host_managed', 100000, 200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'muse-spark-1.2-contributor' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'deepseek/deepseek-v4-flash-vision-exp', 'host_managed', 220000, 660000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'deepseek-v4-flash-vision-exp' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'tencent/hy-mt2-1.8b', 'host_managed', 44000, 177000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hy-mt2-1.8b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'tencent/hy-mt2-30b-a3b', 'host_managed', 74000, 295000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hy-mt2-30b-a3b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~z-ai/glm-latest', 'host_managed', 1400000, 4400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'glm-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'tencent/hy-mt2-7b', 'host_managed', 74000, 295000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hy-mt2-7b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'dots-studio/dots-3-note-preview:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'dots-3-note-preview-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3.7-flash:batch', 'host_managed', 187500, 937500, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.7-flash-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'liquid/lfm-2.5-2.6b:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'lfm-2.5-2.6b-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nvidia/nemotron-3.5-lightning:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nemotron-3.5-lightning-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meta/muse-spark-1.2', 'host_managed', 1250000, 4250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'muse-spark-1.2' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~deepseek/deepseek-v4-flash-latest', 'host_managed', 40000, 80000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'deepseek-v4-flash-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'thinkingmachines/inkling-small:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'inkling-small-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-opus-5:batch', 'host_managed', 2500000, 12500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-opus-5-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'inclusionai/ling-3.0-flash', 'host_managed', 21000, 63000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'ling-3.0-flash' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'poolside/laguna-s-2.1', 'host_managed', 90000, 180000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'laguna-s-2.1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'poolside/laguna-s-2.1:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'laguna-s-2.1-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3.6-flash:batch', 'host_managed', 375000, 1875000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.6-flash-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3.5-flash-lite:batch', 'host_managed', 150000, 1250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.5-flash-lite-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meituan/longcat-2.0', 'host_managed', 300000, 1200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'longcat-2.0' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'thinkingmachines/inkling:batch', 'host_managed', 1000000, 4050000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'inkling-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'thinkingmachines/inkling:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'inkling-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meta/muse-spark-1.1', 'host_managed', 1250000, 4250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'muse-spark-1.1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'kwaipilot/kat-coder-air-v2.5', 'host_managed', 150000, 600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'kat-coder-air-v2.5' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'kwaipilot/kat-coder-pro-v2.5', 'host_managed', 740000, 2960000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'kat-coder-pro-v2.5' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.6-luna-pro:batch', 'host_managed', 100000, 600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.6-luna-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.6-luna:batch', 'host_managed', 100000, 600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.6-luna-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.6-terra-pro:batch', 'host_managed', 1000000, 6000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.6-terra-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.6-terra:batch', 'host_managed', 1000000, 6000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.6-terra-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.6-sol-pro:batch', 'host_managed', 1000000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.6-sol-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.6-sol:batch', 'host_managed', 1000000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.6-sol-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~x-ai/grok-latest', 'host_managed', 2000000, 6000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'grok-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'aion-labs/aion-3.0-mini', 'host_managed', 700000, 1400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'aion-3.0-mini' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'aion-labs/aion-3.0', 'host_managed', 3000000, 6000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'aion-3.0' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'tencent/hy3', 'host_managed', 132000, 528000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hy3' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'poolside/laguna-xs-2.1', 'host_managed', 60000, 120000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'laguna-xs-2.1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'poolside/laguna-xs-2.1:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'laguna-xs-2.1-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-sonnet-5:batch', 'host_managed', 1000000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-sonnet-5-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nex-agi/nex-n2-mini', 'host_managed', 25000, 100000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nex-n2-mini' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'sakana/fugu-ultra', 'host_managed', 5000000, 30000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'fugu-ultra' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'cohere/north-mini-code:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'north-mini-code-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'z-ai/glm-5.2:batch', 'host_managed', 1400000, 4400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'glm-5.2-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'z-ai/glm-5.2:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'glm-5.2-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'moonshotai/kimi-k2.7-code:batch', 'host_managed', 950000, 4000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'kimi-k2.7-code-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~anthropic/claude-fable-latest', 'host_managed', 10000000, 50000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-fable-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-fable-5:batch', 'host_managed', 5000000, 25000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-fable-5-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nex-agi/nex-n2-pro', 'host_managed', 250000, 1000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nex-n2-pro' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nvidia/nemotron-3.5-content-safety:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nemotron-3.5-content-safety-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:batch', 'host_managed', 600000, 3600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nemotron-3-ultra-550b-a55b-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nemotron-3-ultra-550b-a55b-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'minimax/minimax-m3:batch', 'host_managed', 300000, 1200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'minimax-m3-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-opus-4.8:batch', 'host_managed', 2500000, 12500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-opus-4.8-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3.5-flash:batch', 'host_managed', 750000, 4500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.5-flash-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'perceptron/perceptron-mk1', 'host_managed', 150000, 1500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'perceptron-mk1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'inclusionai/ring-2.6-1t', 'host_managed', 75000, 625000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'ring-2.6-1t' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3.1-flash-lite:batch', 'host_managed', 125000, 750000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.1-flash-lite-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'ibm-granite/granite-4.1-8b', 'host_managed', 50000, 100000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'granite-4.1-8b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nemotron-3-nano-omni-30b-a3b-reasoning-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~anthropic/claude-haiku-latest', 'host_managed', 1000000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-haiku-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~openai/gpt-mini-latest', 'host_managed', 750000, 4500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-mini-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~google/gemini-pro-latest', 'host_managed', 2000000, 12000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-pro-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~moonshotai/kimi-latest', 'host_managed', 2600000, 13000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'kimi-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~google/gemini-flash-latest', 'host_managed', 375000, 1875000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-flash-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~anthropic/claude-sonnet-latest', 'host_managed', 2000000, 10000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-sonnet-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~openai/gpt-latest', 'host_managed', 2000000, 10000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3.5-plus-20260420', 'host_managed', 300000, 1800000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3.5-plus-20260420' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3.6-flash', 'host_managed', 187500, 1125000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3.6-flash' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3.6-max-preview', 'host_managed', 1027000, 6162000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3.6-max-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.5-pro:batch', 'host_managed', 15000000, 90000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.5-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.5:batch', 'host_managed', 2500000, 15000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.5-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'inclusionai/ling-2.6-1t', 'host_managed', 75000, 625000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'ling-2.6-1t' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'tencent/hy3-preview', 'host_managed', 180000, 600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hy3-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'xiaomi/mimo-v2.5-pro', 'host_managed', 435000, 870000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mimo-v2.5-pro' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'xiaomi/mimo-v2.5', 'host_managed', 140000, 280000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mimo-v2.5' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.4-image-2', 'host_managed', 8000000, 15000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.4-image-2' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'inclusionai/ling-2.6-flash', 'host_managed', 10000, 30000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'ling-2.6-flash' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', '~anthropic/claude-opus-latest', 'host_managed', 5000000, 25000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-opus-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-opus-4.7:batch', 'host_managed', 2500000, 12500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-opus-4.7-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemma-4-26b-a4b-it:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemma-4-26b-a4b-it-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3.6-plus', 'host_managed', 325000, 1950000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3.6-plus' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'arcee-ai/trinity-large-thinking', 'host_managed', 220000, 850000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'trinity-large-thinking' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'x-ai/grok-4.20', 'host_managed', 1250000, 2500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'grok-4.20' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/lyria-3-pro-preview', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'lyria-3-pro-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/lyria-3-clip-preview', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'lyria-3-clip-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'kwaipilot/kat-coder-pro-v2', 'host_managed', 300000, 1200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'kat-coder-pro-v2' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'rekaai/reka-edge', 'host_managed', 100000, 100000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'reka-edge' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.4-nano:batch', 'host_managed', 100000, 625000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.4-nano-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.4-mini:batch', 'host_managed', 375000, 2250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.4-mini-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'bytedance-seed/seed-2.0-lite', 'host_managed', 250000, 2000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'seed-2.0-lite' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.4-pro:batch', 'host_managed', 15000000, 90000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.4-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.4:batch', 'host_managed', 1250000, 7500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.4-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'inception/mercury-2', 'host_managed', 250000, 750000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mercury-2' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'bytedance-seed/seed-2.0-mini', 'host_managed', 100000, 400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'seed-2.0-mini' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3.5-flash-02-23', 'host_managed', 65000, 260000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3.5-flash-02-23' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3.1-pro-preview-customtools', 'host_managed', 2000000, 12000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.1-pro-preview-customtools' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'aion-labs/aion-2.0', 'host_managed', 800000, 1600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'aion-2.0' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3.1-pro-preview', 'host_managed', 2000000, 12000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.1-pro-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3.1-pro-preview:batch', 'host_managed', 1000000, 6000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.1-pro-preview-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-sonnet-4.6:batch', 'host_managed', 1500000, 7500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-sonnet-4.6-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3.5-plus-02-15', 'host_managed', 260000, 1560000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3.5-plus-02-15' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3-max-thinking', 'host_managed', 780000, 3900000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3-max-thinking' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-opus-4.6:batch', 'host_managed', 2500000, 12500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-opus-4.6-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openrouter/free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'openrouter-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'upstage/solar-pro-3', 'host_managed', 150000, 600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'solar-pro-3' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'minimax/minimax-m2-her', 'host_managed', 300000, 1200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'minimax-m2-her' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'bytedance-seed/seed-1.6-flash', 'host_managed', 75000, 300000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'seed-1.6-flash' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'bytedance-seed/seed-1.6', 'host_managed', 250000, 2000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'seed-1.6' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3-flash-preview', 'host_managed', 500000, 3000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3-flash-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-3-flash-preview:batch', 'host_managed', 250000, 1500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3-flash-preview-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.2-pro', 'host_managed', 21000000, 168000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.2-pro' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.2-pro:batch', 'host_managed', 10500000, 84000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.2-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.2:batch', 'host_managed', 875000, 7000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.2-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'relace/relace-search', 'host_managed', 1000000, 3000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'relace-search' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'z-ai/glm-4.6v', 'host_managed', 300000, 900000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'glm-4.6v' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mistral-large-2512', 'host_managed', 500000, 1500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mistral-large-2512' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-opus-4.5:batch', 'host_managed', 2500000, 12500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-opus-4.5-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'allenai/olmo-3-32b-think', 'host_managed', 150000, 500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'olmo-3-32b-think' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5.1:batch', 'host_managed', 625000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5.1-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'amazon/nova-premier-v1', 'host_managed', 2500000, 12500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nova-premier-v1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'perplexity/sonar-pro-search', 'host_managed', 3000000, 15000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'sonar-pro-search' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'ibm-granite/granite-4.0-h-micro', 'host_managed', 17000, 112000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'granite-4.0-h-micro' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5-image-mini', 'host_managed', 2500000, 2000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5-image-mini' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-haiku-4.5:batch', 'host_managed', 500000, 2500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-haiku-4.5-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5-image', 'host_managed', 10000000, 10000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5-image' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-flash-image', 'host_managed', 300000, 2500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-flash-image' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5-pro:batch', 'host_managed', 7500000, 60000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-sonnet-4.5:batch', 'host_managed', 1500000, 7500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-sonnet-4.5-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'deepseek/deepseek-v3.2-exp', 'host_managed', 270000, 410000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'deepseek-v3.2-exp' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'thedrummer/cydonia-24b-v4.1', 'host_managed', 300000, 500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'cydonia-24b-v4.1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'relace/relace-apply-3', 'host_managed', 850000, 1250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'relace-apply-3' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3-max', 'host_managed', 780000, 3900000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3-max' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3-coder-plus', 'host_managed', 650000, 3250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3-coder-plus' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5-codex:batch', 'host_managed', 625000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5-codex-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3-coder-flash', 'host_managed', 195000, 975000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3-coder-flash' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen-plus-2025-07-28', 'host_managed', 260000, 780000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen-plus-2025-07-28' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen-plus-2025-07-28:thinking', 'host_managed', 260000, 780000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen-plus-2025-07-28-thinking' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nvidia/nemotron-nano-9b-v2:free', 'host_managed', 0, 0, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'nemotron-nano-9b-v2-free' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'moonshotai/kimi-k2-0905', 'host_managed', 600000, 2500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'kimi-k2-0905' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nousresearch/hermes-4-70b', 'host_managed', 130000, 400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hermes-4-70b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nousresearch/hermes-4-405b', 'host_managed', 1000000, 3000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hermes-4-405b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mistral-medium-3.1', 'host_managed', 400000, 2000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mistral-medium-3.1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5:batch', 'host_managed', 625000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5-mini:batch', 'host_managed', 125000, 1000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5-mini-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-5-nano:batch', 'host_managed', 25000, 200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5-nano-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-opus-4.1:batch', 'host_managed', 7500000, 37500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-opus-4.1-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/codestral-2508', 'host_managed', 300000, 900000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'codestral-2508' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'bytedance/ui-tars-1.5-7b', 'host_managed', 100000, 200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'ui-tars-1.5-7b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-flash-lite', 'host_managed', 100000, 400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-flash-lite' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-flash-lite:batch', 'host_managed', 50000, 200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-flash-lite-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'cognitivecomputations/dolphin-mistral-24b-venice-edition', 'host_managed', 200000, 900000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'dolphin-mistral-24b-venice-edition' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'tencent/hunyuan-a13b-instruct', 'host_managed', 140000, 570000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hunyuan-a13b-instruct' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'morph/morph-v3-large', 'host_managed', 900000, 1900000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'morph-v3-large' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'morph/morph-v3-fast', 'host_managed', 800000, 1200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'morph-v3-fast' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'baidu/ernie-4.5-vl-424b-a47b', 'host_managed', 420000, 1250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'ernie-4.5-vl-424b-a47b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mistral-small-3.2-24b-instruct', 'host_managed', 75000, 200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mistral-small-3.2-24b-instruct' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'minimax/minimax-m1', 'host_managed', 550000, 2200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'minimax-m1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-flash', 'host_managed', 300000, 2500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-flash' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-flash:batch', 'host_managed', 150000, 1250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-flash-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-pro', 'host_managed', 1250000, 10000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-pro' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-pro:batch', 'host_managed', 625000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o3-pro:batch', 'host_managed', 10000000, 40000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o3-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-pro-preview', 'host_managed', 1250000, 10000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-pro-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-opus-4', 'host_managed', 15000000, 75000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-opus-4' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-sonnet-4', 'host_managed', 3000000, 15000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-sonnet-4' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mistral-medium-3', 'host_managed', 400000, 2000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mistral-medium-3' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemini-2.5-pro-preview-05-06', 'host_managed', 1250000, 10000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-pro-preview-05-06' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'arcee-ai/virtuoso-large', 'host_managed', 750000, 1200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'virtuoso-large' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meta-llama/llama-guard-4-12b', 'host_managed', 180000, 180000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'llama-guard-4-12b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o4-mini-high', 'host_managed', 1100000, 4400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o4-mini-high' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o4-mini-high:batch', 'host_managed', 550000, 2200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o4-mini-high-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o3:batch', 'host_managed', 1000000, 4000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o3-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o4-mini:batch', 'host_managed', 550000, 2200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o4-mini-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-4.1:batch', 'host_managed', 1000000, 4000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4.1-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-4.1-mini:batch', 'host_managed', 200000, 800000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4.1-mini-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-4.1-nano:batch', 'host_managed', 50000, 200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4.1-nano-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meta-llama/llama-4-maverick', 'host_managed', 200000, 800000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'llama-4-maverick' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meta-llama/llama-4-scout', 'host_managed', 100000, 300000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'llama-4-scout' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o1-pro:batch', 'host_managed', 75000000, 300000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o1-pro-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mistral-small-3.1-24b-instruct', 'host_managed', 351000, 555000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mistral-small-3.1-24b-instruct' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'cohere/command-a', 'host_managed', 2500000, 10000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'command-a' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'rekaai/reka-flash-3', 'host_managed', 100000, 200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'reka-flash-3' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'thedrummer/skyfall-36b-v2', 'host_managed', 550000, 800000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'skyfall-36b-v2' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'perplexity/sonar-reasoning-pro', 'host_managed', 2000000, 8000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'sonar-reasoning-pro' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'perplexity/sonar-pro', 'host_managed', 3000000, 15000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'sonar-pro' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'perplexity/sonar-deep-research', 'host_managed', 2000000, 8000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'sonar-deep-research' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mistral-saba', 'host_managed', 200000, 600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mistral-saba' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o3-mini-high', 'host_managed', 1100000, 4400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o3-mini-high' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o3-mini-high:batch', 'host_managed', 550000, 2200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o3-mini-high-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'aion-labs/aion-rp-llama-3.1-8b', 'host_managed', 800000, 1600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'aion-rp-llama-3.1-8b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen2.5-vl-72b-instruct', 'host_managed', 800000, 1000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen2.5-vl-72b-instruct' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen-plus', 'host_managed', 260000, 780000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen-plus' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o3-mini:batch', 'host_managed', 550000, 2200000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o3-mini-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'perplexity/sonar', 'host_managed', 1000000, 1000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'sonar' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'minimax/minimax-01', 'host_managed', 200000, 1100000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'minimax-01' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'microsoft/phi-4', 'host_managed', 70000, 140000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'phi-4' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'sao10k/l3.3-euryale-70b', 'host_managed', 650000, 750000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'llama-3.3-euryale-70b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/o1:batch', 'host_managed', 7500000, 30000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o1-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'cohere/command-r7b-12-2024', 'host_managed', 37500, 150000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'command-r7b-12-2024' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meta-llama/llama-3.3-70b-instruct', 'host_managed', 100000, 320000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'llama-3.3-70b-instruct' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'thedrummer/unslopnemo-12b', 'host_managed', 400000, 400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'unslopnemo-12b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthracite-org/magnum-v4-72b', 'host_managed', 3000000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'magnum-v4-72b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/ministral-8b', 'host_managed', 110000, 110000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'ministral-8b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'thedrummer/rocinante-12b', 'host_managed', 250000, 500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'rocinante-12b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'cohere/command-r-08-2024', 'host_managed', 150000, 600000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'command-r-08-2024' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'cohere/command-r-plus-08-2024', 'host_managed', 2500000, 10000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'command-r-plus-08-2024' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'sao10k/l3.1-euryale-70b', 'host_managed', 850000, 850000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'llama-3.1-euryale-70b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nousresearch/hermes-3-llama-3.1-70b', 'host_managed', 700000, 700000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hermes-3-llama-3.1-70b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'nousresearch/hermes-3-llama-3.1-405b', 'host_managed', 1000000, 1000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'hermes-3-llama-3.1-405b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'sao10k/l3-lunaris-8b', 'host_managed', 40000, 50000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'llama-3-lunaris-8b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'meta-llama/llama-3.1-70b-instruct', 'host_managed', 400000, 400000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'llama-3.1-70b-instruct' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mistral-nemo', 'host_managed', 19000, 30000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mistral-nemo' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-4o-mini:batch', 'host_managed', 75000, 300000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4o-mini-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemma-2-27b-it', 'host_managed', 650000, 650000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemma-2-27b-it' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-4o:batch', 'host_managed', 1250000, 5000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4o-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mixtral-8x22b-instruct', 'host_managed', 2000000, 6000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mixtral-8x22b-instruct' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'microsoft/wizardlm-2-8x22b', 'host_managed', 620000, 620000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'wizardlm-2-8x22b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-4-turbo:batch', 'host_managed', 5000000, 15000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4-turbo-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'anthropic/claude-3-haiku', 'host_managed', 250000, 1250000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'claude-3-haiku' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mistralai/mistral-large', 'host_managed', 2000000, 6000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'mistral-large' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-3.5-turbo-0613', 'host_managed', 1000000, 2000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo-0613' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-4-turbo-preview', 'host_managed', 10000000, 30000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4-turbo-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-3.5-turbo-instruct', 'host_managed', 1500000, 2000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo-instruct' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-3.5-turbo-16k', 'host_managed', 3000000, 4000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo-16k' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'mancer/weaver', 'host_managed', 500000, 750000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'weaver' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'undi95/remm-slerp-l2-13b', 'host_managed', 450000, 650000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'remm-slerp-l2-13b' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-3.5-turbo', 'host_managed', 500000, 1500000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-3.5-turbo:batch', 'host_managed', 250000, 750000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo-batch' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'openai/gpt-4', 'host_managed', 30000000, 60000000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'davinci-002', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'davinci-002' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'babbage-002', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'babbage-002' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'gpt-3.5-turbo-instruct-0914', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo-instruct-0914' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'gpt-3.5-turbo-1106', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo-1106' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'tts-1-hd', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'tts-1-hd' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'tts-1-1106', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'tts-1-1106' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'tts-1-hd-1106', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'tts-1-hd-1106' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'text-embedding-3-small', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'text-embedding-3-small' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'text-embedding-3-large', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'text-embedding-3-large' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'gpt-3.5-turbo-0125', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo-0125' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'omni-moderation-2024-09-26', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'omni-moderation' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'gpt-4o-mini-search-preview-2025-03-11', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4o-mini-search-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'o4-mini-deep-research', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'o4-mini-deep-research' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'gpt-5-search-api', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-5-search-api' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'sora-2-pro', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'sora-2-pro' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'chatgpt-image-latest', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'chatgpt-image-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'gpt-4o-search-preview', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4o-search-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'tts-1', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'tts-1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'whisper-1', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'whisper-1' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'text-embedding-ada-002', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'text-embedding-ada-002' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-2.5-flash-preview-tts', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-flash-preview-tts' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-2.5-pro-preview-tts', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-pro-preview-tts' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-flash-lite-latest', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-flash-lite-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-omni-flash-preview', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-omni-flash-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-3.1-flash-tts-preview', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-3.1-flash-tts-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-robotics-er-1.6-preview', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-robotics-er-1.6-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-robotics-er-2-preview', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-robotics-er-2-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-2.5-computer-use-preview-10-2025', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-2.5-computer-use-preview-10-2025' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'antigravity-preview-05-2026', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'antigravity-preview-05-2026' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'deep-research-max-preview-04-2026', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'deep-research-max-preview-04-2026' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'deep-research-preview-04-2026', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'deep-research-preview-04-2026' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'deep-research-pro-preview-12-2025', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'deep-research-pro-preview-12-2025' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
-- daily sync 2026-08-24
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('gemma-3n-e4b-it', 'Gemma 3n E4B Instruct', '2025-05-20', 32768, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('step-3.5-flash', 'Step 3.5 Flash', '2026-01-29', 262144, '{text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.models (slug, display_name, release_date, context_window, input_modalities)
values ('qwen3-vl-8b-thinking', 'Qwen3 VL 8B Thinking', '2025-10-14', 131072, '{image,text}')
on conflict (slug, owning_org_id) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-flash-latest', 'customer_managed', null, null, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-flash-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'gemini', 'gemini-pro-latest', 'customer_managed', null, null, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemini-pro-latest' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'gpt-3.5-turbo-16k', 'customer_managed', null, null, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-3.5-turbo-16k' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'gpt-4o-mini-search-preview', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gpt-4o-mini-search-preview' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openai', 'omni-moderation-latest', 'customer_managed', 0, 0, 'estimate', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'omni-moderation' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'google/gemma-3n-e4b-it', 'host_managed', 60000, 120000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'gemma-3n-e4b-it' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'qwen/qwen3-vl-8b-thinking', 'host_managed', 180000, 2100000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'qwen3-vl-8b-thinking' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
insert into public.model_providers (model_id, provider, provider_model_id, billing_source, input_micro_usd_per_million, output_micro_usd_per_million, pricing_source, capabilities)
select m.id, 'openrouter', 'stepfun/step-3.5-flash', 'host_managed', 100000, 300000, 'openrouter', '{"supports_streaming": true}'::jsonb
from public.models m where m.slug = 'step-3.5-flash' and m.owning_org_id is null
on conflict (model_id, provider, provider_model_id, owning_org_id, base_url) do nothing;
-- END DAILY-SYNC MODELS
