begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

-- Cost controls: per-key TOKENS-per-minute limit (P1022, migrations
-- 20260822100000 + 20260822130000). TPM is trailing observation over SETTLED
-- tokens: the gate sums input + cached input + output + reasoning tokens of
-- the key's host-lane attempts with terminal_at in the last 60s and refuses
-- the NEXT dispatch at or past the limit. No default: only an explicit
-- gateway_key_limits.tokens_per_minute arms it. Host lane only, like every
-- money gate. This suite pins the gate through the COMPOSED final
-- gateway_start_attempt body (the merge-train hazard: a later whole-body
-- redefinition that drops the TPM block fails here).

-- ---------------------------------------------------------------------------
-- Fixtures: one org (topped up, so the free-credit daily caps are off), four
-- keys with different TPM arrangements, one alias/revision.

insert into public.organizations (id, slug, name) values
  ('65000000-0000-0000-0000-000000000001', 'pgtap-tpm-tenant', 'pgTAP TPM');

insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source)
values ('65000000-0000-0000-0000-000000000001', 'grant', 1000, 'pgTAP headroom', 'admin');
insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source, source_ref)
values ('65000000-0000-0000-0000-000000000001', 'topup', 5, 'pgTAP top-up',
        'stripe', 'cs_test_pgtap_tpm');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('65000000-0000-0000-0000-000000000011', '65000000-0000-0000-0000-000000000001',
   'k-under', 'xpl_tp1', encode(sha256('tpm-k1'::bytea), 'hex'), null),
  ('65000000-0000-0000-0000-000000000012', '65000000-0000-0000-0000-000000000001',
   'k-at', 'xpl_tp2', encode(sha256('tpm-k2'::bytea), 'hex'), null),
  ('65000000-0000-0000-0000-000000000013', '65000000-0000-0000-0000-000000000001',
   'k-stale', 'xpl_tp3', encode(sha256('tpm-k3'::bytea), 'hex'), null),
  ('65000000-0000-0000-0000-000000000014', '65000000-0000-0000-0000-000000000001',
   'k-norow', 'xpl_tp4', encode(sha256('tpm-k4'::bytea), 'hex'), null);
-- (identity_id is assigned by the api_keys default-identity trigger.)

-- Explicit limits: rpm/cap uncapped so ONLY the TPM verdict can fire.
insert into public.gateway_key_limits
  (api_key_id, daily_spend_cap_micro_usd, requests_per_minute, tokens_per_minute)
values
  ('65000000-0000-0000-0000-000000000011', null, null, 1000),
  ('65000000-0000-0000-0000-000000000012', null, null, 100),
  ('65000000-0000-0000-0000-000000000013', null, null, 100);

insert into public.gateway_catalog_snapshots (catalog_sha256, document, models_document)
  values (repeat('ee', 32), '{}'::jsonb, '{}'::jsonb);
insert into public.gateway_aliases (alias_id, alias_name, org_id, active, origin)
  values ('alias-tpm', 'tpm', '65000000-0000-0000-0000-000000000001', true, 'named');
insert into public.gateway_alias_revisions (
  revision_id, alias_id, target, catalog_sha256, provider_connection_revisions
) values (
  'rev-tpm', 'alias-tpm', '{"pool_id":"pool-tpm"}'::jsonb, repeat('ee', 32), '{}'::jsonb
);

-- Carrier requests (one per key under test).
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
)
select
  'tpm-r-' || suffix, '65000000-0000-0000-0000-000000000001',
  ('65000000-0000-0000-0000-0000000000' || suffix)::uuid, 'tpm', 'rev-tpm',
  'chat_completions', encode(sha256(('tpm-' || suffix)::bytea), 'hex'),
  now(), now() + interval '1 hour'
from unnest(array['11', '12', '13', '14']) as suffix;

-- Settled token history. started_at is 10 minutes back so the RPM window
-- (started_at-based) never sees these; TPM windows on terminal_at.
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, api_key_id, attempt_ordinal, route_depth,
  deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
  billing_source, state, started_at, terminal_at,
  input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
  budget_period_start, budget_reserved_micro_usd, budget_settled_micro_usd
) values
  -- k-under: 400 + 200 + 200 + 100 = 900 tokens settled just now (< 1000).
  ('tpm-a-under', 'tpm-r-11', '65000000-0000-0000-0000-000000000001',
   '65000000-0000-0000-0000-000000000011', 0, 0,
   'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '5 seconds',
   400, 200, 200, 100,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   1000000, 1000000),
  -- k-at: exactly 100 tokens settled just now (= its limit).
  ('tpm-a-at', 'tpm-r-12', '65000000-0000-0000-0000-000000000001',
   '65000000-0000-0000-0000-000000000012', 0, 0,
   'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '5 seconds',
   60, 0, 40, 0,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   1000000, 1000000),
  -- k-stale: a mountain of tokens, but settled 10 minutes ago (outside 60s).
  ('tpm-a-stale', 'tpm-r-13', '65000000-0000-0000-0000-000000000001',
   '65000000-0000-0000-0000-000000000013', 0, 0,
   'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '10 minutes',
   500000, 0, 500000, 0,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   1000000, 1000000),
  -- k-norow: no limits row at all; a huge settled burst just now must not
  -- gate anything (there is NO default TPM).
  ('tpm-a-norow', 'tpm-r-14', '65000000-0000-0000-0000-000000000001',
   '65000000-0000-0000-0000-000000000014', 0, 0,
   'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '5 seconds',
   500000, 0, 500000, 0,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   1000000, 1000000),
  -- k-at also has a BYOK burst just now: pass-through tokens must never
  -- count toward the host-lane TPM window.
  ('tpm-a-byok', 'tpm-r-12', '65000000-0000-0000-0000-000000000001',
   '65000000-0000-0000-0000-000000000012', 1, 0,
   'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32), 'customer_managed',
   'completed', now() - interval '10 minutes', now() - interval '5 seconds',
   900000, 0, 900000, 0,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   0, 0);

-- ---------------------------------------------------------------------------
-- 1. Under the limit: 900 of 1000 tokens in the window still dispatches.

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'tpm-r-11', '65000000-0000-0000-0000-000000000001', 1, 0,
    'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'a key under its TPM limit dispatches (900 settled of 1000 in the window)'
);

-- ---------------------------------------------------------------------------
-- 2-3. At the limit: the NEXT dispatch is refused with P1022 and the message
--      names the fix; all four token kinds counted (60 input + 40 output).

select throws_ok(
  $$select public.gateway_start_attempt(
    'tpm-r-12', '65000000-0000-0000-0000-000000000001', 2, 0,
    'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)$$,
  'P1022',
  null,
  'a key at its TPM limit is refused on the next dispatch (P1022, trailing observation)'
);

select throws_like(
  $$select public.gateway_start_attempt(
    'tpm-r-12', '65000000-0000-0000-0000-000000000001', 2, 0,
    'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)$$,
  '%key_token_rate_limit%tokens-per-minute%',
  'the TPM refusal names the guard and the knob'
);

-- ---------------------------------------------------------------------------
-- 4. The window is real: the same 100-token limit ignores a million tokens
--    settled 10 minutes ago.

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'tpm-r-13', '65000000-0000-0000-0000-000000000001', 1, 0,
    'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'tokens settled outside the 60s window never count (the window drains)'
);

-- ---------------------------------------------------------------------------
-- 5. No default: a key with no limits row is never token-gated, whatever it
--    just settled.

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'tpm-r-14', '65000000-0000-0000-0000-000000000001', 1, 0,
    'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'no limits row means no TPM (there is deliberately no token default)'
);

-- ---------------------------------------------------------------------------
-- 6. BYOK dispatch is never blocked: the same at-limit key dispatches freely
--    on the customer_managed lane.

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'tpm-r-12', '65000000-0000-0000-0000-000000000001', 3, 0,
    'dep-tpm', 'prov', 'm-t', 'pool-tpm', repeat('ee', 32),
    'customer_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'BYOK dispatch is never token-gated (host-lane only, like every money gate)'
);

-- ---------------------------------------------------------------------------
-- 7. BYOK tokens are invisible to the host gate: k-at's 1.8M pass-through
--    tokens did not add to its 100-token host window (the P1022 above fired
--    on exactly the 100 host tokens; if BYOK counted, k-under's 900 + BYOK
--    would also have tripped its 1000). Pin the sum the gate reads.

select is(
  (select coalesce(pg_catalog.sum(
      coalesce(input_tokens, 0) + coalesce(cached_input_tokens, 0)
      + coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0)), 0)
     from public.gateway_attempts
    where api_key_id = '65000000-0000-0000-0000-000000000012'
      and billing_source = 'host_managed'
      and terminal_at is not null
      and terminal_at >= pg_catalog.clock_timestamp() - interval '60 seconds'),
  100::pg_catalog.int8,
  'the host-lane window sum excludes pass-through tokens'
);

-- ---------------------------------------------------------------------------
-- 8. The effective-limits read reports the knob in lockstep.

select is(
  (select tokens_per_minute from public.gateway_key_limits_effective(
    '65000000-0000-0000-0000-000000000012')),
  100,
  'gateway_key_limits_effective reports the explicit tokens_per_minute'
);

select * from finish();

rollback;
