-- Demo-shape seed: a fully-populated demo organization for local/dev evaluation.
--
-- Purpose: after a local `supabase db reset` (or a docker stack up), a person
-- can sign in as the demo user and see EVERY workspace surface alive with
-- realistic data — Overview's 90-day activity graph + top-models + spend,
-- telemetry request history, the credits ledger, and KeyHub (API keys +
-- provider connections with status history). Nothing here is random: every
-- value is derived deterministically from a day/model index, so two resets
-- produce byte-identical data and the graphs never "flicker" between runs.
--
-- Guardrails / boundaries:
--   * DEV-ONLY. Refuses to run when explabs.demo_seed_environment resolves to
--     'production' (the seed scripts pass EXPLABS_DEPLOYMENT_ENVIRONMENT
--     through, defaulting to 'local'). Production is never seeded anyway
--     (production-deploy.yml does not run any seed script); this is defense in
--     depth, mirroring the fixture guard in explabs/integrations.
--   * Append-only respected. gateway_usage_events / gateway_requests /
--     credit_ledger are insert-only (their mutation-block triggers forbid
--     UPDATE/DELETE). This seed only INSERTs historical rows, keyed on stable
--     ids with ON CONFLICT DO NOTHING, so a re-run without a reset is a no-op.
--   * Idempotent. Stable ids everywhere; the one non-append-only sample table
--     (provider_account_snapshots) is delete-then-insert scoped to the demo org.
--
-- Runs after seed.sql (which attaches the signup-org trigger). The demo auth
-- users are seeded users, so — exactly like the admin user — we point the
-- explabs.seed_admin_email GUC at each demo email while inserting it, which is
-- the trigger's own skip path for seeded users (no auto personal org).

\set ON_ERROR_STOP on

-- Insert one demo auth user + its email identity, with the signup-org trigger
-- skipped for that email. Mirrors the admin block in seed.sql.
create or replace function pg_temp.seed_demo_auth_user(
  p_user_id uuid,
  p_email text,
  p_password text
)
returns void
language plpgsql
as $$
begin
  -- The signup-org trigger skips the email currently in this GUC. Seeded demo
  -- users must not receive an auto-provisioned personal org, so claim the skip
  -- for the duration of this insert.
  perform set_config('explabs.seed_admin_email', p_email, false);

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, recovery_sent_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  )
  values (
    '00000000-0000-0000-0000-000000000000',
    p_user_id, 'authenticated', 'authenticated', p_email,
    crypt(p_password, gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb, now(), now(), '', '', '', ''
  )
  on conflict (id) do update set
    aud = excluded.aud,
    role = excluded.role,
    email = excluded.email,
    encrypted_password = excluded.encrypted_password,
    email_confirmed_at = excluded.email_confirmed_at,
    raw_app_meta_data = excluded.raw_app_meta_data,
    updated_at = now();

  delete from auth.identities where user_id = p_user_id and provider = 'email';
  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  )
  values (
    p_user_id, p_user_id, p_user_id::text,
    jsonb_build_object(
      'sub', p_user_id::text, 'email', p_email,
      'email_verified', true, 'phone_verified', false
    ),
    'email', now(), now(), now()
  );
end;
$$;

do $$
declare
  -- Environment guard.
  v_env text := lower(coalesce(
    nullif(current_setting('explabs.demo_seed_environment', true), ''), 'local'));

  -- Stable demo identity.
  v_org   uuid := 'd0d0d0d0-0000-0000-0000-000000000001';
  v_user  uuid := 'd0d0d0d0-0000-0000-0000-000000000099';
  v_mate1 uuid := 'd0d0d0d0-0000-0000-0000-000000000097';
  v_mate2 uuid := 'd0d0d0d0-0000-0000-0000-000000000096';
  v_key1  uuid := 'd0d0d0d0-0000-0000-0000-0000000a0001';
  v_key2  uuid := 'd0d0d0d0-0000-0000-0000-0000000a0002';
  v_endpoint uuid := 'd0d0d0d0-0000-0000-0000-00000000e001';

  v_email    text := coalesce(
    nullif(current_setting('explabs.demo_seed_email', true), ''),
    'demo@experientiallabs.ai');
  v_password text := coalesce(
    nullif(current_setting('explabs.demo_seed_password', true), ''),
    'DemoShape2026!');
  v_orig_admin text := current_setting('explabs.seed_admin_email', true);

  -- One documented, working platform key (plaintext is safe to publish: it is
  -- a known local-dev credential, see docker/README.md). key_hash is the
  -- SHA-256 of the plaintext, exactly as the mint path stores it.
  v_key1_plain text := 'xpl_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  v_key2_plain text := 'xpl_00d3f00d00d3f00d00d3f00d00d3f00d00d3f00d';

  -- Provider connections are seeded ONLY from real keys sourced from the seed
  -- env (never a fake secret). Since BYOK connections actually route, a fake
  -- key would hijack the org's traffic for that provider onto the pass-through
  -- lane and fail auth on every live call; a real key demonstrates a genuine
  -- pass-through lane, and where no key is present the provider is simply
  -- absent (its models fall back to the platform-funded lane / clean provider
  -- error). openai is deliberately NOT seeded as BYOK so its models stay on
  -- the platform-funded lane the app serves via its ambient key — that is the
  -- demo's platform-funded showcase.
  pc record;
  v_conn uuid;

  -- Daily-usage generation state.
  d int;
  m record;
  v_day date;
  v_dow int;
  v_total int;
  v_req int;
  v_in bigint;
  v_out bigint;
  v_cost_all bigint;
  v_cost bigint;
  v_est bigint;
  v_pf_total bigint := 0;  -- summed platform_funded (charged) micro-USD

  -- Identity-tier (budgets/grants) state.
  v_period text;
  v_month_start timestamptz;

  -- Event/request sample state.
  n int := 0;
  v_ev int;
  e int;
  v_status text;
  v_lat int;
  v_ein bigint;
  v_eout bigint;
  v_ecost bigint;
  v_eest bigint;
  v_attempts int;
  v_accepted timestamptz;
  v_terminal timestamptz;
  v_reqid text;
  v_svcost numeric;
begin
  if v_env = 'production' then
    raise notice 'seed-demo: refusing to seed the demo org in a production environment; skipping.';
    return;
  end if;
  if to_regclass('auth.users') is null then
    raise notice 'seed-demo: auth.users does not exist yet; skipping (runs in the auth-seed pass).';
    return;
  end if;
  -- Skip gracefully if the gateway runtime / billing / connection schema this
  -- seed depends on is not fully present. The assembled stack has all of these;
  -- a partial base does not. Skipping (rather than erroring) keeps the seed
  -- scripts' ON_ERROR_STOP from aborting the rest of the seed pass.
  if to_regclass('public.gateway_usage_daily') is null
     or to_regclass('public.gateway_usage_events') is null
     or to_regclass('public.gateway_requests') is null
     or to_regclass('public.credit_ledger') is null
     or to_regclass('public.provider_connections') is null
     or to_regclass('public.provider_account_snapshots') is null
     or to_regclass('public.org_labels') is null
     or to_regclass('public.serving_requests') is null
     or to_regclass('public.api_keys') is null
     or to_regclass('public.gateway_key_limits') is null then
    raise notice 'seed-demo: gateway runtime/billing/connection schema not fully present; skipping the demo org (needs the assembled schema).';
    return;
  end if;

  -- ---------------------------------------------------------------------------
  -- 1. Demo org, users, membership, workspace.

  insert into public.organizations (id, slug, name)
  values (v_org, 'demo', 'Demo Org (YC S26)')
  on conflict (id) do update set slug = excluded.slug, name = excluded.name;

  perform pg_temp.seed_demo_auth_user(v_user, v_email, v_password);
  perform pg_temp.seed_demo_auth_user(v_mate1, 'sarah.chen@demo-co.ai', 'DemoShape2026!');
  perform pg_temp.seed_demo_auth_user(v_mate2, 'marcus.webb@demo-co.ai', 'DemoShape2026!');
  -- Restore the real admin skip email for anything that runs after us.
  perform set_config('explabs.seed_admin_email', coalesce(v_orig_admin, ''), false);

  insert into public.organization_members (org_id, user_id, role) values
    (v_org, v_user, 'admin'),
    (v_org, v_mate1, 'user'),
    (v_org, v_mate2, 'user')
  on conflict (org_id, user_id) do update set role = excluded.role;

  -- Sign-in lands the demo user in the demo org.
  insert into public.account_workspaces (user_id, org_id)
  values (v_user, v_org)
  on conflict (user_id) do update set org_id = excluded.org_id;

  -- ---------------------------------------------------------------------------
  -- 2. Credits: signup grant ($20, auto on org insert) + YC launch grant +
  --    two Stripe top-ups, so /credits shows a real balance and history.

  -- Mark the demo org a YC company (the `yc` label) and apply the $526 launch
  -- grant, folding the $20 signup promo in. apply_yc_launch_grant is idempotent
  -- and records the promo reversal itself, so the demo org lands at exactly $526
  -- of YC credit whether or not this seed has run before.
  perform public.apply_yc_launch_grant(v_org, 526, null, v_user);

  insert into public.credit_ledger (id, org_id, entry_type, amount_usd, reason, source, source_ref, created_at) values
    ('d0d0d0d0-0000-0000-0000-0000000c0001', v_org, 'topup', 50, 'Credit top-up', 'stripe', 'demo-topup-1', now() - interval '40 days'),
    ('d0d0d0d0-0000-0000-0000-0000000c0002', v_org, 'topup', 200, 'Credit top-up', 'stripe', 'demo-topup-2', now() - interval '12 days')
  on conflict (id) do nothing;

  -- ---------------------------------------------------------------------------
  -- 3. API keys (KeyHub) + one per-key guardrail row.

  insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by, created_at, last_used_at) values
    (v_key1, v_org, 'Production', left(v_key1_plain, 12), encode(digest(v_key1_plain, 'sha256'), 'hex'), v_user, now() - interval '88 days', now() - interval '2 hours'),
    (v_key2, v_org, 'Staging', left(v_key2_plain, 12), encode(digest(v_key2_plain, 'sha256'), 'hex'), v_user, now() - interval '60 days', now() - interval '3 days')
  on conflict (id) do nothing;

  insert into public.gateway_key_limits (api_key_id, daily_spend_cap_micro_usd, requests_per_minute)
  values (v_key1, 50000000, 120)
  on conflict (api_key_id) do nothing;

  -- ---------------------------------------------------------------------------
  -- 4. Provider connections (KeyHub) — real keys only, sourced from the seed
  --    env (explabs.demo_provider_key_*), skipped when the key is absent. Each
  --    created connection is written through the sanctioned RPC (handles Vault),
  --    marked valid, given a declared balance, and backfilled with ~60 days of
  --    balance/status snapshots so the KeyHub sparklines have history. Snapshot
  --    rows are delete-then-insert (not append-only) for idempotence.
  -- Remove any connection a previous run of this seed created for a provider we
  -- are NOT seeding this run — the retired fake openai connection, or a provider
  -- whose key is absent this run — so a stale/fake credential can never hijack
  -- routing (a lingering fake key fails auth on every live call for its
  -- provider's models). Providers we do seed are upserted in place below (stable
  -- ids). Only seed-created rows (created_by = 'demo-seed') are touched; a
  -- user-added connection is left alone. No-op on a fresh stack.
  delete from public.provider_connections
   where org_id = v_org
     and created_by = 'demo-seed'
     and provider not in (
       select k.provider from (values
         ('openrouter', current_setting('explabs.demo_provider_key_openrouter', true)),
         ('anthropic',  current_setting('explabs.demo_provider_key_anthropic', true))
       ) as k(provider, api_key)
       where k.api_key is not null and pg_catalog.length(k.api_key) >= 12
     );

  delete from public.provider_account_snapshots where org_id = v_org;
  for pc in
    select * from (values
      -- provider, key GUC, declared balance, low-balance threshold
      ('openrouter', current_setting('explabs.demo_provider_key_openrouter', true), 130.00, 20),
      ('anthropic',  current_setting('explabs.demo_provider_key_anthropic', true),  180.00, 25)
    ) as t(provider, api_key, declared_balance, threshold)
  loop
    continue when pc.api_key is null or pg_catalog.length(pc.api_key) < 12;
    select id into v_conn from public.upsert_provider_connection(
      v_org, pc.provider, '{}'::jsonb, pc.api_key, 'demo-seed');
    update public.provider_connections set
      status = 'valid', status_source = 'hookup_check',
      status_checked_at = now() - interval '20 minutes',
      declared_balance_usd = pc.declared_balance,
      declared_balance_set_at = now() - interval '20 minutes',
      low_balance_threshold_usd = pc.threshold
    where id = v_conn;
    for e in 0..7 loop
      insert into public.provider_account_snapshots
        (org_id, connection_id, provider, taken_at, spend_usd, credits_remaining_usd, usage_limit_usd, source)
      values (
        v_org, v_conn, pc.provider,
        (now() - make_interval(days => (60 - e * 8)))::date,
        6 + e * 5.5, pc.declared_balance - e * 5.5, pc.declared_balance, 'provider_api'
      );
    end loop;
  end loop;

  -- ---------------------------------------------------------------------------
  -- 5. 90 days of per-day / per-model usage rollup (gateway_usage_daily) for
  --    the demo user. This is what Overview's activity graph, top-models, and
  --    spend chart read (personal scope filters on user_id). Deterministic
  --    texture: slow growth, weekend dips, a few launch-day spikes, small
  --    day-index wiggle; every day is active so the streak is contiguous.
  --
  --    Model mix (alias, provider, exact_model_id, lane, in_rate, out_rate,
  --    per-mille share, avg input, avg output). Rates are micro-USD per
  --    million tokens from the launch catalog; cost = tokens*rate/1e6.
  for d in 0..89 loop
    v_day := current_date - (89 - d);
    v_dow := extract(dow from v_day)::int;
    v_total := greatest(
      6,
      round(
        ((18 + d * 0.85) * (case when v_dow in (0, 6) then 0.5 else 1.0 end)
          + ((d * 7) % 13) - 6)
        * (case when d in (20, 44, 63, 82) then 2.0 else 1.0 end)
      )::numeric
    )::int;

    for m in
      select * from (values
        -- lane follows provider: openai -> platform_funded (served via the
        -- app's ambient key), openrouter -> pass_through (served via the demo
        -- org's BYOK connection), matching how the connections above route.
        ('gpt-5.6-sol',      'openai',     'gpt-5.6-sol',              'platform_funded', 5000000::bigint, 30000000::bigint, 260, 1200, 420),
        ('gemini-3.7-flash', 'openrouter', 'google/gemini-3.7-flash',  'pass_through',     375000::bigint,  1875000::bigint, 240, 1600, 520),
        ('qwen3.6-27b',      'openrouter', 'qwen/qwen3.6-27b',         'pass_through',     300000::bigint,  2000000::bigint, 180, 1400, 480),
        ('gpt-5.6-terra',    'openai',     'gpt-5.6-terra',            'platform_funded', 2000000::bigint, 12000000::bigint, 140, 1100, 380),
        ('deepseek-v4-pro',  'openrouter', 'deepseek/deepseek-v4-pro', 'pass_through',    1440000::bigint,  2880000::bigint, 100, 2000, 700),
        ('kimi-k2.6',        'openrouter', 'moonshotai/kimi-k2.6',     'pass_through',     541500::bigint,  2280000::bigint,  80, 1800, 600)
      ) as t(alias, provider, exact_model_id, lane, in_rate, out_rate, share_milli, avg_in, avg_out)
    loop
      v_req := round(v_total * m.share_milli / 1000.0)::int;
      continue when v_req = 0;
      v_in := v_req::bigint * m.avg_in;
      v_out := v_req::bigint * m.avg_out;
      v_cost_all := round((v_in::numeric * m.in_rate + v_out::numeric * m.out_rate) / 1000000)::bigint;
      if m.lane = 'platform_funded' then
        v_cost := v_cost_all; v_est := 0; v_pf_total := v_pf_total + v_cost_all;
      else
        v_cost := 0; v_est := v_cost_all;
      end if;

      insert into public.gateway_usage_daily
        (org_id, user_id, day, alias, requests, input_tokens, output_tokens, spend_micro_usd)
      values (v_org, v_user, v_day, m.alias, v_req, v_in, v_out, v_cost + v_est)
      on conflict on constraint gateway_usage_daily_pkey do nothing;
    end loop;
  end loop;

  -- Reflect the charged (platform_funded) spend on the org's credit meter, the
  -- same column gateway_settle_billing draws down, so /credits' balance agrees
  -- with the usage on Overview. Absolute set keeps it idempotent.
  update public.organizations
     set billable_spend_usd = round(v_pf_total / 1000000.0, 6)
   where id = v_org;

  -- Two teammates with a lighter recent slice, so workspace-scope top-users
  -- has more than one row and the Members section reads as a real team.
  for d in 60..89 loop
    v_day := current_date - (89 - d);
    insert into public.gateway_usage_daily
      (org_id, user_id, day, alias, requests, input_tokens, output_tokens, spend_micro_usd)
    values
      (v_org, v_mate1, v_day, 'gemini-3.7-flash', 4 + (d % 5), (4 + (d % 5)) * 1500, (4 + (d % 5)) * 500,
        round(((4 + (d % 5)) * 1500 * 375000.0 + (4 + (d % 5)) * 500 * 1875000.0) / 1000000)::bigint),
      (v_org, v_mate2, v_day, 'gpt-5.6-sol', 2 + (d % 3), (2 + (d % 3)) * 1200, (2 + (d % 3)) * 400,
        round(((2 + (d % 3)) * 1200 * 5000000.0 + (2 + (d % 3)) * 400 * 30000000.0) / 1000000)::bigint)
    on conflict on constraint gateway_usage_daily_pkey do nothing;
  end loop;

  -- ---------------------------------------------------------------------------
  -- 6. Per-request sample for the last ~24 days: gateway_requests (+ its
  --    canonical usage event) and serving_requests, so the telemetry request
  --    log / per-request history render with a real mix of statuses, lanes,
  --    latencies, and a couple of errors. request_ids are stable, so the
  --    append-only insert is a no-op on re-run.
  for d in 66..89 loop
    v_day := current_date - (89 - d);
    for m in
      select * from (values
        ('gpt-5.6-sol',      'openai',     'gpt-5.6-sol',              'platform_funded', 5000000::bigint, 30000000::bigint, 1200, 420),
        ('gemini-3.7-flash', 'openrouter', 'google/gemini-3.7-flash',  'pass_through',     375000::bigint,  1875000::bigint, 1600, 520),
        ('qwen3.6-27b',      'openrouter', 'qwen/qwen3.6-27b',         'pass_through',     300000::bigint,  2000000::bigint, 1400, 480),
        ('gpt-5.6-terra',    'openai',     'gpt-5.6-terra',            'platform_funded', 2000000::bigint, 12000000::bigint, 1100, 380),
        ('deepseek-v4-pro',  'openrouter', 'deepseek/deepseek-v4-pro', 'pass_through',    1440000::bigint,  2880000::bigint, 2000, 700)
      ) as t(alias, provider, exact_model_id, lane, in_rate, out_rate, avg_in, avg_out)
    loop
      v_ev := 1 + ((d + length(m.alias)) % 3);  -- 1..3 events per model per day
      for e in 1..v_ev loop
        n := n + 1;
        v_reqid := 'demo-req-' || n;
        v_status := case
          when n % 17 = 0 then 'failed'
          when n % 29 = 0 then 'cancelled'
          when n % 41 = 0 then 'incomplete'
          else 'completed' end;
        v_lat := 250 + ((n * 37) % 3600);
        v_attempts := case when n % 13 = 0 then 2 else 1 end;
        v_ein := (m.avg_in + ((n * 11) % 500) - 250)::bigint;
        v_eout := case
          when v_status = 'failed' then 0::bigint
          when v_status = 'incomplete' then ((m.avg_out / 3) + (n % 60))::bigint
          else (m.avg_out + ((n * 7) % 400) - 200)::bigint end;
        v_ecost := round((v_ein::numeric * m.in_rate + v_eout::numeric * m.out_rate) / 1000000)::bigint;
        v_accepted := v_day::timestamptz + make_interval(hours => (n % 22) + 1, mins => (n * 13) % 60);
        v_terminal := v_accepted + make_interval(secs => v_lat / 1000.0);

        if m.lane = 'platform_funded' then
          -- Zero-completion insurance: a failed platform_funded attempt bills 0.
          v_cost := case when v_status = 'failed' then 0 else v_ecost end;
          v_eest := 0;
        else
          v_cost := 0;
          v_eest := v_ecost;
        end if;

        insert into public.gateway_requests (
          request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
          canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
        ) values (
          v_reqid, v_org, v_key1, m.alias, 'demo-rev-' || m.alias, 'chat_completions',
          encode(digest(v_reqid, 'sha256'), 'hex'),
          v_accepted, v_accepted + interval '60 seconds', v_status, v_terminal
        )
        on conflict (request_id) do nothing;

        insert into public.gateway_usage_events (
          request_id, org_id, api_key_id, user_id, alias, provider, lane,
          input_tokens, output_tokens, cost_micro_usd, estimated_cost_micro_usd,
          latency_ms, status, attempt_count, day, created_at
        ) values (
          v_reqid, v_org, v_key1, v_user, m.alias, m.provider, m.lane,
          v_ein, v_eout, v_cost, v_eest, v_lat, v_status, v_attempts,
          (v_terminal at time zone 'UTC')::date, v_terminal
        )
        on conflict (request_id) do nothing;

        -- Shipped telemetry page reads serving_requests; mirror the same call.
        v_svcost := round((v_cost + v_eest) / 1000000.0, 6);
        insert into public.serving_requests (
          id, org_id, endpoint_id, endpoint_label, model, input_tokens, output_tokens,
          cached_tokens, cost_usd, latency_ms, ttfb_ms, status, error_message, created_at
        ) values (
          ('d0d0d0d0-0000-0000-0000-' || lpad(to_hex(n), 12, '0'))::uuid,
          v_org, v_endpoint, m.alias, m.exact_model_id, v_ein, v_eout,
          0, v_svcost, v_lat, (v_lat / 4),
          case when v_status = 'failed' then 'error' else 'ok' end,
          case when v_status = 'failed' then 'upstream provider error' else null end,
          v_terminal
        )
        on conflict (id) do nothing;
      end loop;
    end loop;
  end loop;

  -- ---------------------------------------------------------------------------
  -- 7. Identity tier (present only once gw/identity-pe is in the schema): make
  --    the per-identity/per-scope BUDGET "limit spend" feature and full public
  --    catalog access visible on the Identities & access surface.
  if to_regclass('public.gateway_budgets') is not null
     and to_regprocedure('public.gateway_seed_org_identity_tier(pg_catalog.uuid)') is not null then

    -- S6: backfill the demo org's default identity with grants for the FULL
    -- current public catalog. The org-insert trigger only granted what existed
    -- when the org was first created (backfill drift), and a re-seed upserts the
    -- org (no INSERT, so the trigger does not re-fire). This canonical,
    -- idempotent call re-evaluates against the current catalog and adds the
    -- missing grants, matching exactly what a fresh org receives.
    perform public.gateway_seed_org_identity_tier(v_org);

    -- Attribute the demo API keys to the default identity so per-identity budget
    -- meters capture their spend. Idempotent; only fills keys not already set.
    update public.api_keys
       set identity_id = 'org-' || v_org
     where org_id = v_org and identity_id is null;

    -- S5: monthly budgets for the CURRENT month — one team-wide and one on the
    -- default identity — so the budget meters render. Budgets store only the
    -- limit + scope; reserved/settled/remaining are DERIVED at read from
    -- gateway_attempts. Deterministic ids keyed on the period keep re-seeds
    -- idempotent (the scope unique index has no name usable in ON CONFLICT).
    v_period := to_char(now(), 'YYYY-MM');
    v_month_start := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';

    insert into public.gateway_budgets (budget_id, org_id, period, scope_kind, limit_micro_usd)
    values ('budget-demo-team-' || v_period, v_org, v_period, 'team', 50000000)
    on conflict (budget_id) do nothing;
    insert into public.gateway_budgets (budget_id, org_id, period, scope_kind, identity_id, limit_micro_usd)
    values ('budget-demo-identity-' || v_period, v_org, v_period, 'identity', 'org-' || v_org, 20000000)
    on conflict (budget_id) do nothing;

    -- Current-month host_managed attempts (platform-funded lane) so the meters
    -- show real settled spend without needing live traffic: 10 COMPLETED
    -- (settled) attempts totalling ~$6.75 against the $50 team / $20 identity
    -- budgets, attributed to the demo key so both team- and identity-scope
    -- meters populate. All terminal on purpose — a seeded 'dispatched' attempt
    -- has a past deadline, so the gateway crash-reconciler would sweep it on a
    -- live stack (releasing the reservation), making any seeded 'reserved'
    -- amount transient; settled money is the stable, honest thing to show.
    for e in 1..10 loop
      v_reqid := 'demo-budget-req-' || e;
      insert into public.gateway_requests (
        request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
        canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
      ) values (
        v_reqid, v_org, v_key1,
        case when e % 3 = 0 then 'gpt-5.6-terra' else 'gpt-5.6-sol' end,
        'demo-rev-budget', 'chat_completions',
        encode(digest(v_reqid, 'sha256'), 'hex'),
        v_month_start + make_interval(hours => e),
        v_month_start + make_interval(hours => e) + interval '60 seconds',
        'completed', v_month_start + make_interval(hours => e, secs => 2)
      ) on conflict (request_id) do nothing;

      insert into public.gateway_attempts (
        attempt_id, request_id, org_id, attempt_ordinal, route_depth,
        deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
        billing_source, state, started_at, terminal_at, budget_period_start,
        budget_reserved_micro_usd, budget_settled_micro_usd
      ) values (
        'demo-budget-att-' || e, v_reqid, v_org, 0, 0,
        'demo-deploy-openai', 'openai',
        case when e % 3 = 0 then 'gpt-5.6-terra' else 'gpt-5.6-sol' end,
        'demo-pool-openai', encode(digest('demo-budget-catalog', 'sha256'), 'hex'),
        'host_managed', 'completed',
        v_month_start + make_interval(hours => e),
        v_month_start + make_interval(hours => e, secs => 2),
        v_month_start,
        (400000 + e * 50000)::bigint, (400000 + e * 50000)::bigint
      ) on conflict (attempt_id) do nothing;
    end loop;
  end if;

  raise notice 'seed-demo: demo org % populated (% platform-funded micro-USD charged, % sample requests).',
    v_org, v_pf_total, n;
end;
$$;
