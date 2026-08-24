-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- The DEMO ACCOUNT: demo@experientiallabs.ai in its own "Demo Workspace" org,
-- carrying a full, believable month of platform activity so every customer
-- surface renders with real volume the moment someone signs in:
--   * Overview: ~30 days of spend, top models, a three-way member split.
--   * Telemetry: a raw request log + timeseries + by-platform breakdown
--     (gateway_requests + gateway_usage_events, pass_through lane, estimated
--     cost only — NEVER charged money), plus an Imported card fed from
--     synthetic local Claude Code / Codex metadata.
--   * /credits: provider connections with declared balances and snapshots,
--     and two tool accounts.
--
-- Contract mirrors seed.sql: every statement is an idempotent upsert or is
-- guarded, so re-running is safe. The usage history generates ONCE per
-- database (guarded on the demoseed- request prefix); a reseed of a wiped
-- branch regenerates it fresh with days relative to the seed date.
--
-- Ordering: run AFTER seed.sql (orgs, auth idiom) and AFTER
-- seed-gateway-catalog.sql (list prices). With an empty catalog the usage
-- blocks skip with a notice instead of failing.
--
-- The sign-in password comes from the explabs.seed_demo_password GUC when the
-- caller sets one (production does); otherwise the committed local default
-- below, mirroring the local admin default in scripts/seed_supabase_local.sh.

-- 1. The demo org and its three users -----------------------------------------

insert into public.organizations (id, slug, name, spend_unlocked_at)
values (
  '00000000-0000-0000-0000-000000000010',
  'demo-workspace',
  'Demo Workspace',
  now()
)
on conflict (id) do update set
  slug = excluded.slug,
  name = excluded.name,
  spend_unlocked_at = coalesce(public.organizations.spend_unlocked_at, excluded.spend_unlocked_at);

do $$
declare
  demo_password text := coalesce(
    nullif(current_setting('explabs.seed_demo_password', true), ''),
    'Demo00T321!'
  );
  member record;
begin
  if to_regclass('auth.users') is null then
    raise notice 'Skipping demo auth seed because auth.users does not exist yet.';
    return;
  end if;

  for member in
    select *
    from (values
      ('00000000-0000-0000-0000-000000000090'::uuid, 'demo@experientiallabs.ai',     'admin'),
      ('00000000-0000-0000-0000-000000000091'::uuid, 'mia.demo@experientiallabs.ai', 'user'),
      ('00000000-0000-0000-0000-000000000092'::uuid, 'leo.demo@experientiallabs.ai', 'user')
    ) as m(user_id, email, org_role)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, recovery_sent_at, last_sign_in_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    )
    values (
      '00000000-0000-0000-0000-000000000000',
      member.user_id, 'authenticated', 'authenticated', member.email,
      crypt(demo_password, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      now(), now(), '', '', '', ''
    )
    on conflict (id) do update set
      email = excluded.email,
      encrypted_password = excluded.encrypted_password,
      email_confirmed_at = excluded.email_confirmed_at,
      updated_at = now();

    if to_regclass('auth.identities') is not null then
      delete from auth.identities
      where user_id = member.user_id and provider = 'email';
      insert into auth.identities (
        id, user_id, provider_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      )
      values (
        member.user_id, member.user_id, member.user_id::text,
        jsonb_build_object(
          'sub', member.user_id::text,
          'email', member.email,
          'email_verified', true,
          'phone_verified', false
        ),
        'email', now(), now(), now()
      );
    end if;

    insert into public.organization_members (org_id, user_id, role)
    values ('00000000-0000-0000-0000-000000000010', member.user_id, member.org_role)
    on conflict (org_id, user_id) do update set role = excluded.role;
  end loop;

  -- Signing in lands demo@ in the demo workspace, like any bootstrapped account.
  insert into public.account_workspaces (user_id, org_id)
  values ('00000000-0000-0000-0000-000000000090', '00000000-0000-0000-0000-000000000010')
  on conflict (user_id) do update set org_id = excluded.org_id;
  -- Deliberately NOT a platform admin: the demo shows the customer product only.
end
$$;

-- 2. Attribution API keys ------------------------------------------------------
-- Unusable random hashes: these exist so the request log and members card have
-- real key labels, never to authenticate.

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by)
select k.id::uuid, '00000000-0000-0000-0000-000000000010', k.name, 'xpl_demo',
       encode(digest(gen_random_uuid()::text, 'sha256'), 'hex'), k.created_by::uuid
from (values
  ('00000000-0000-0000-0000-00000000d001', 'prod-router', null),
  ('00000000-0000-0000-0000-00000000d002', 'ci-evals',    '00000000-0000-0000-0000-000000000090'),
  ('00000000-0000-0000-0000-00000000d003', 'dev-mia',     '00000000-0000-0000-0000-000000000091'),
  ('00000000-0000-0000-0000-00000000d004', 'dev-leo',     '00000000-0000-0000-0000-000000000092')
) as k(id, name, created_by)
on conflict (id) do nothing;

-- 3. Thirty days of gateway usage ---------------------------------------------
-- ~27,000 pass_through requests over the trailing 30 days, drawn lognormally per
-- model family, priced from the live catalog, attributed across the members.

do $$
declare
  demo_org constant uuid := '00000000-0000-0000-0000-000000000010';
  n_requests constant int := 27000;
  total_estimated_micro bigint;
begin
  if to_regclass('auth.users') is null then
    raise notice 'Skipping demo usage seed until auth exists (rerun seeds after GoTrue).';
    return;
  end if;
  if exists (
    select 1 from public.gateway_requests
    where org_id = demo_org and request_id like 'demoseed-%'
  ) then
    raise notice 'Demo usage history already present; leaving it untouched.';
    return;
  end if;

  -- The model mix, kept to aliases the catalog actually prices; absent aliases
  -- fold out and the remaining weights renormalize implicitly (weighted pick).
  create temp table demo_mix on commit drop as
  select m.alias, m.weight, c.provider,
         c.input_price, coalesce(c.cached_price, c.input_price) as cached_price,
         c.output_price
  from (values
    ('claude-sonnet-5',  0.28),
    ('claude-fable-5',   0.28),
    ('gpt-5.6-luna',     0.16),
    ('gemini-3.7-flash', 0.13),
    ('glm-5.2',          0.15)
  ) as m(alias, weight)
  join lateral (
    select mp.provider,
           mp.input_micro_usd_per_million as input_price,
           mp.cached_input_micro_usd_per_million as cached_price,
           mp.output_micro_usd_per_million as output_price
    from public.model_providers mp
    join public.models mo on mo.id = mp.model_id
    where mo.slug = m.alias
      and mp.status = 'active'
      and mp.input_micro_usd_per_million is not null
      and mp.output_micro_usd_per_million is not null
    order by mp.provider
    limit 1
  ) as c on true;

  if not exists (select 1 from demo_mix) then
    raise notice 'Skipping demo usage seed: the catalog prices none of the demo aliases.';
    return;
  end if;

  create temp table demo_mix_cum on commit drop as
  select alias, provider, input_price, cached_price, output_price,
         sum(weight) over (order by alias) / (select sum(weight) from demo_mix) as cum
  from demo_mix;

  perform setseed(0.42);

  -- One row per request. Token draws are lognormal per model family (agentic
  -- coding traffic: cache-heavy long contexts on the frontier models, short
  -- interactive calls on the flash tier), hours lean US-workday, statuses are
  -- overwhelmingly completed with a realistic failure tail.
  create temp table demo_draws on commit drop as
  with raw as (
    select n,
           random() as r_alias, random() as r_key, random() as r_status,
           random() as r_day, random() as r_hour, random() as r_surface,
           random() as u1, random() as u2, random() as u3, random() as u4,
           random() as u5, random() as u6
    from generate_series(1, n_requests) as n
  ),
  shaped as (
    select raw.*,
           (select mix.alias from demo_mix_cum mix where mix.cum >= raw.r_alias
            order by mix.cum limit 1) as alias,
           -- Trailing 30 days with a mild recency lean.
           (current_date - (floor(power(raw.r_day, 1.2) * 30))::int) as day,
           case
             when raw.r_hour < 0.70 then 13 + (raw.u5 * 10)::int  -- US workday
             else (raw.u5 * 24)::int
           end as hour,
           case
             when raw.r_status < 0.965 then 'completed'
             when raw.r_status < 0.985 then 'failed'
             when raw.r_status < 0.993 then 'cancelled'
             else 'incomplete'
           end as status,
           case
             when raw.r_key < 0.46 then '00000000-0000-0000-0000-00000000d003'::uuid
             when raw.r_key < 0.76 then '00000000-0000-0000-0000-00000000d004'::uuid
             when raw.r_key < 0.92 then '00000000-0000-0000-0000-00000000d001'::uuid
             else '00000000-0000-0000-0000-00000000d002'::uuid
           end as api_key_id,
           case
             when raw.r_key < 0.46 then '00000000-0000-0000-0000-000000000091'::uuid
             when raw.r_key < 0.76 then '00000000-0000-0000-0000-000000000092'::uuid
             when raw.r_key < 0.92 then null
             else '00000000-0000-0000-0000-000000000090'::uuid
           end as user_id
    from raw
  ),
  profiled as (
    select shaped.*,
           mix.provider, mix.input_price, mix.cached_price, mix.output_price,
           case when shaped.alias like 'claude-fable%' then 12000
                when shaped.alias like 'claude-sonnet%' then 8000
                when shaped.alias like 'glm%' then 7000
                else 1800 end as mean_input,
           case when shaped.alias like 'claude-fable%' then 70000
                when shaped.alias like 'claude-sonnet%' then 40000
                when shaped.alias like 'glm%' then 0
                else 4000 end as mean_cached,
           case when shaped.alias like 'claude-fable%' then 2000
                when shaped.alias like 'claude-sonnet%' then 1400
                when shaped.alias like 'glm%' then 1400
                else 350 end as mean_output,
           case when shaped.alias like 'claude%' then 0.9
                when shaped.alias like 'glm%' then 0.8
                else 0.7 end as sigma,
           case when shaped.alias like 'claude-fable%' then 21000
                when shaped.alias like 'claude-sonnet%' then 12000
                when shaped.alias like 'glm%' then 9000
                else 2500 end as mean_latency
    from shaped
    join demo_mix_cum mix on mix.alias = shaped.alias
  )
  select
    'demoseed-' || lpad(n::text, 7, '0') as request_id,
    alias, provider, api_key_id, user_id, status, day,
    greatest(60, (mean_input
      * exp(sigma * sqrt(-2 * ln(u1 + 1e-12)) * cos(2 * pi() * u2)))::bigint)
      as input_tokens,
    case when mean_cached = 0 then 0 else greatest(0, (mean_cached
      * exp(sigma * sqrt(-2 * ln(u3 + 1e-12)) * cos(2 * pi() * u4)))::bigint)
      end as cached_tokens,
    greatest(16, (mean_output
      * exp(sigma * sqrt(-2 * ln(u3 + 1e-12)) * sin(2 * pi() * u4)))::bigint)
      as output_tokens,
    greatest(350, (mean_latency
      * exp(0.6 * sqrt(-2 * ln(u1 + 1e-12)) * sin(2 * pi() * u2)))::int)
      as latency_ms,
    (day::timestamptz
      + make_interval(hours => least(hour, 23), mins => (u6 * 60)::int,
                      secs => (u2 * 60)::int)) as moment,
    input_price, cached_price, output_price,
    case when r_surface < 0.2 then 'responses' else 'chat_completions' end as surface
  from profiled;

  insert into public.gateway_requests (
    request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
    canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
  )
  select request_id, demo_org, api_key_id, alias, 'demo-seed', surface,
         encode(digest(request_id, 'sha256'), 'hex'),
         moment - make_interval(secs => latency_ms / 1000.0),
         moment + interval '10 minutes',
         status, moment
  from demo_draws;

  insert into public.gateway_usage_events (
    request_id, org_id, api_key_id, user_id, alias, provider, lane,
    input_tokens, output_tokens, cached_input_tokens,
    cost_micro_usd, estimated_cost_micro_usd, latency_ms, status,
    attempt_count, day, created_at
  )
  select request_id, demo_org, api_key_id, user_id, alias, provider,
         'pass_through',
         input_tokens + cached_tokens, output_tokens, cached_tokens,
         0,  -- BYOK attribution is never charged money.
         greatest(1, (input_tokens * input_price + cached_tokens * cached_price
                      + output_tokens * output_price) / 1000000),
         latency_ms, status, 1, day, moment
  from demo_draws;

  delete from public.gateway_usage_daily where org_id = demo_org;
  insert into public.gateway_usage_daily
    (org_id, user_id, day, alias, requests, input_tokens, output_tokens, spend_micro_usd)
  select org_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
         day, alias, count(*),
         coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
         coalesce(sum(cost_micro_usd + estimated_cost_micro_usd), 0)
  from public.gateway_usage_events
  where org_id = demo_org
  group by org_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), day, alias;

  select coalesce(sum(estimated_cost_micro_usd), 0) into total_estimated_micro
  from public.gateway_usage_events
  where org_id = demo_org and request_id like 'demoseed-%';
  update public.organizations
  set spend_usd = spend_usd + total_estimated_micro / 1000000.0
  where id = demo_org;

  raise notice 'Demo usage seeded: % requests, ~$% estimated.',
    n_requests, round(total_estimated_micro / 1000000.0);
end
$$;

-- 4. Imported local-usage attribution (the Telemetry "Imported" card) ----------

do $$
declare
  demo_org constant uuid := '00000000-0000-0000-0000-000000000010';
  n_rows constant int := 5200;
begin
  if to_regclass('auth.users') is null then
    return;
  end if;
  if exists (
    select 1 from public.gateway_imported_usage_events
    where org_id = demo_org and batch_id = 'demoseed'
  ) then
    raise notice 'Demo imported history already present; leaving it untouched.';
    return;
  end if;

  perform setseed(0.43);
  insert into public.gateway_imported_usage_events (
    org_id, record_hash, user_id, batch_id, import_source, model_raw,
    alias, provider, model_matched,
    input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
    estimated_cost_micro_usd, occurred_at, day
  )
  select demo_org,
         encode(digest('demoseed-imp-' || d.n, 'sha256'), 'hex'),
         '00000000-0000-0000-0000-000000000090',
         'demoseed', d.source, d.model_raw,
         c.alias, c.provider, c.alias is not null,
         d.input_tokens, d.output_tokens, d.cached_tokens, 0,
         case when c.alias is null then 0
              else greatest(1, (d.input_tokens * c.input_price
                                + d.cached_tokens * coalesce(c.cached_price, c.input_price)
                                + d.output_tokens * c.output_price) / 1000000)
         end,
         d.occurred_at, (d.occurred_at at time zone 'UTC')::date
  from (
    select n,
           case when random() < 0.62 then 'claude-code' else 'codex' end as source,
           case
             -- A slice of raw model ids the catalog does not carry, so the
             -- Imported card honestly shows unmatched (uncosted) rows too.
             when random() < 0.08 then 'claude-opus-4-8'
             when random() < 0.55 then 'claude-fable-5'
             when random() < 0.75 then 'claude-sonnet-5'
             else 'gpt-5.6-luna'
           end as model_raw,
           greatest(120, (5000 * exp(0.9 * sqrt(-2 * ln(random() + 1e-12))
             * cos(2 * pi() * random())))::bigint) as input_tokens,
           greatest(0, (45000 * exp(0.9 * sqrt(-2 * ln(random() + 1e-12))
             * cos(2 * pi() * random())))::bigint) as cached_tokens,
           greatest(16, (900 * exp(0.9 * sqrt(-2 * ln(random() + 1e-12))
             * sin(2 * pi() * random())))::bigint) as output_tokens,
           now() - make_interval(
             days => (power(random(), 1.2) * 30)::int,
             hours => (random() * 24)::int,
             mins => (random() * 60)::int) as occurred_at
    from generate_series(1, n_rows) as n
  ) as d
  left join lateral (
    select mo.slug as alias, mp.provider,
           mp.input_micro_usd_per_million as input_price,
           mp.cached_input_micro_usd_per_million as cached_price,
           mp.output_micro_usd_per_million as output_price
    from public.models mo
    join public.model_providers mp on mp.model_id = mo.id
    where mo.slug = d.model_raw
      and mp.status = 'active'
      and mp.input_micro_usd_per_million is not null
      and mp.output_micro_usd_per_million is not null
    order by mp.provider
    limit 1
  ) as c on true
  on conflict (org_id, record_hash) do nothing;

  raise notice 'Demo imported history seeded: % rows.', n_rows;
end
$$;

-- 5. /credits: provider connections, snapshots, tool accounts ------------------
-- Dummy Vault credentials: the balances render from the DECLARED figures and
-- self-reported snapshots; the nightly sweep will record failed reads on these
-- rows (harmless — the declared drawdown keeps rendering).

do $$
declare
  demo_org constant uuid := '00000000-0000-0000-0000-000000000010';
begin
  if to_regclass('vault.secrets') is null then
    raise notice 'Skipping demo credits seed: Vault is unavailable.';
    return;
  end if;

  insert into public.provider_connections
    (id, org_id, provider, config, vault_secret_id, credential_last4, created_by,
     declared_balance_usd, declared_balance_set_at, metered_spend_usd,
     low_balance_threshold_usd, status, status_source, status_checked_at)
  select gen_random_uuid(), demo_org, v.provider, '{}'::jsonb,
         vault.create_secret('demo-seed-credential', 'demoseed:' || v.provider || ':' || gen_random_uuid()),
         v.last4, 'demo@experientiallabs.ai',
         v.declared, now() - interval '3 days', v.metered, v.threshold,
         'valid', 'hookup_check', now() - interval '6 hours'
  from (values
    ('anthropic', 'dm3A', 2500.00, 212.40, 250.0),
    ('openai',    'dm9Q', 1200.00,  84.15, 120.0),
    ('gemini',    'dm7W',  600.00,  22.60,  60.0)
  ) as v(provider, last4, declared, metered, threshold)
  where not exists (
    select 1 from public.provider_connections pc
    where pc.org_id = demo_org and pc.provider = v.provider
  );

  insert into public.provider_account_snapshots
    (id, org_id, connection_id, provider, taken_at, spend_usd,
     credits_remaining_usd, usage_limit_usd, source, detail)
  select gen_random_uuid(), pc.org_id, pc.id, pc.provider,
         now() - interval '2 hours', v.spend, v.remaining, null, 'self_reported',
         '{}'::jsonb
  from public.provider_connections pc
  join (values
    ('anthropic', 212.40, 2287.60),
    ('openai',     84.15, 1115.85),
    ('gemini',     22.60,  577.40)
  ) as v(provider, spend, remaining) on v.provider = pc.provider
  where pc.org_id = demo_org
    and not exists (
      select 1 from public.provider_account_snapshots s where s.connection_id = pc.id
    );

  if to_regclass('public.tool_accounts') is not null then
    insert into public.tool_accounts
      (id, org_id, vendor, config, credential_last4, declared_balance_usd,
       declared_balance_set_at, balance_source, low_balance_threshold_usd,
       last_fetch_at, last_fetch_status, last_fetch_message, created_by)
    select gen_random_uuid(), demo_org, v.vendor, '{}'::jsonb, v.last4, v.declared,
           now() - interval '3 days', v.source, v.threshold,
           now() - interval '2 hours', v.status, v.message,
           'demo@experientiallabs.ai'
    from (values
      ('e2b',    null,   300.00, 'self_reported', 50.0, 'not_reportable',
       'E2B exposes no balance API; tracked from the declared figure.'),
      ('cursor', 'dm6C', 220.00, 'vendor_api',    40.0, 'reported',
       'Cursor Admin API spend read.')
    ) as v(vendor, last4, declared, source, threshold, status, message)
    where not exists (
      select 1 from public.tool_accounts t
      where t.org_id = demo_org and t.vendor = v.vendor
    );
  end if;
end
$$;

-- Bulk inserts leave the planner blind; refresh stats in the same seed pass
-- (production incident lesson, 2026-08-22).
analyze public.gateway_requests;
analyze public.gateway_usage_events;
analyze public.gateway_usage_daily;
analyze public.gateway_imported_usage_events;
