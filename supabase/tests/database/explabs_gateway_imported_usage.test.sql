begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

-- Fixture orgs (imported usage references organizations on delete cascade).
insert into public.organizations (id, slug, name) values
  ('62000000-0000-0000-0000-000000000001', 'pgtap-import-a', 'pgTAP Import A'),
  ('62000000-0000-0000-0000-000000000002', 'pgtap-import-b', 'pgTAP Import B');

-- Real record hashes are sha256 hex; the fixtures use valid 64-hex strings.
-- h1/h2 stand in for two distinct turns.

-- ---------------------------------------------------------------------------
-- Shape: the table exists, identity is (org_id, record_hash), money is the
-- estimated (never-charged) column only.

select has_table('public', 'gateway_imported_usage_events', 'imported usage table exists');
select col_is_pk(
  'public', 'gateway_imported_usage_events', ARRAY['org_id', 'record_hash'],
  'identity is (org_id, record_hash), not batch-scoped'
);
select has_column(
  'public', 'gateway_imported_usage_events', 'estimated_cost_micro_usd',
  'money is the estimated (never-charged) column'
);
select hasnt_column(
  'public', 'gateway_imported_usage_events', 'cost_micro_usd',
  'no charged-money column exists on imported usage'
);

-- ---------------------------------------------------------------------------
-- Protection matches the rest of the gateway store: revoke-then-grant, RLS on
-- with no policy. The service role (which bypasses RLS) may read/insert/update
-- but not delete; anon/authenticated hold nothing after the revoke.

select is(
  (select relrowsecurity from pg_class where oid = 'public.gateway_imported_usage_events'::regclass),
  true,
  'row level security is enabled'
);
select is(
  (select count(*)::int from pg_policies
     where schemaname = 'public' and tablename = 'gateway_imported_usage_events'),
  0,
  'no RLS policy exists, so non-service roles read nothing'
);
select ok(
  has_table_privilege('service_role', 'public.gateway_imported_usage_events', 'SELECT'),
  'service_role can read'
);
select ok(
  has_table_privilege('service_role', 'public.gateway_imported_usage_events', 'INSERT'),
  'service_role can insert'
);
select ok(
  has_table_privilege('service_role', 'public.gateway_imported_usage_events', 'UPDATE'),
  'service_role can update (re-import corrects a mapping in place)'
);
select ok(
  not has_table_privilege('service_role', 'public.gateway_imported_usage_events', 'DELETE'),
  'service_role cannot delete rows'
);
select ok(
  not has_table_privilege('anon', 'public.gateway_imported_usage_events', 'SELECT'),
  'anon holds no privilege after the revoke'
);
select ok(
  not has_table_privilege('authenticated', 'public.gateway_imported_usage_events', 'SELECT'),
  'authenticated holds no privilege after the revoke'
);

-- ---------------------------------------------------------------------------
-- Behavior: import_source is constrained; dedupe is by (org, record_hash)
-- regardless of batch; a re-import overwrites the mapping in place.

select throws_ok(
  format(
    $$insert into public.gateway_imported_usage_events
        (org_id, record_hash, batch_id, import_source, model_raw, model_matched,
         estimated_cost_micro_usd, occurred_at, day)
      values ('62000000-0000-0000-0000-000000000001', %L, 'b', 'chatgpt',
              'x', false, 0, now(), (now() at time zone 'UTC')::date)$$,
    repeat('c', 64)
  ),
  '23514',
  null,
  'import_source is constrained to the known tools'
);

insert into public.gateway_imported_usage_events
  (org_id, record_hash, batch_id, import_source, model_raw, alias, model_matched,
   estimated_cost_micro_usd, occurred_at, day)
values
  ('62000000-0000-0000-0000-000000000001', repeat('a', 64), 'batch-1', 'claude-code',
   'claude-opus-4-8-preview', null, false, 0, now(), (now() at time zone 'UTC')::date);

-- Same turn, a DIFFERENT batch id: dedupe must hold and NOT double-count.
insert into public.gateway_imported_usage_events
  (org_id, record_hash, batch_id, import_source, model_raw, alias, provider, model_matched,
   estimated_cost_micro_usd, occurred_at, day)
values
  ('62000000-0000-0000-0000-000000000001', repeat('a', 64), 'batch-2', 'claude-code',
   'claude-opus-4-8-preview', 'claude-opus-4-8', 'anthropic', true, 1500, now(),
   (now() at time zone 'UTC')::date)
on conflict (org_id, record_hash) do update set
  alias = excluded.alias,
  provider = excluded.provider,
  model_matched = excluded.model_matched,
  estimated_cost_micro_usd = excluded.estimated_cost_micro_usd;

select is(
  (select count(*)::int from public.gateway_imported_usage_events
     where org_id = '62000000-0000-0000-0000-000000000001'),
  1,
  'a re-import under a new batch id does not add a second row'
);
select is(
  (select estimated_cost_micro_usd from public.gateway_imported_usage_events
     where org_id = '62000000-0000-0000-0000-000000000001' and record_hash = repeat('a', 64)),
  1500::int8,
  're-import overwrote the corrected cost in place'
);
select is(
  (select model_matched from public.gateway_imported_usage_events
     where org_id = '62000000-0000-0000-0000-000000000001' and record_hash = repeat('a', 64)),
  true,
  're-import overwrote the corrected mapping in place'
);

-- ---------------------------------------------------------------------------
-- RPC: gateway_imported_usage_by_model is the Logs rollup. Privilege is
-- service_role only; aggregation, tenant scope, matched-vs-raw, totals, and
-- cost/request ordering must match ImportedModelRollup.

select has_function(
  'public',
  'gateway_imported_usage_by_model',
  array['uuid'],
  'the imported-usage rollup RPC exists'
);

select ok(
  (
    select procedures.prosecdef
      and procedures.proconfig = array['search_path=""']::text[]
    from pg_proc as procedures
    where procedures.oid = (
      'public.gateway_imported_usage_by_model(uuid)'
    )::regprocedure
  ),
  'the imported-usage rollup is SECURITY DEFINER with an empty search path'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.gateway_imported_usage_by_model(uuid)',
    'execute'
  ),
  'service_role can execute the imported-usage rollup'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.gateway_imported_usage_by_model(uuid)',
    'execute'
  ),
  'anon cannot execute the imported-usage rollup'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.gateway_imported_usage_by_model(uuid)',
    'execute'
  ),
  'authenticated cannot execute the imported-usage rollup'
);

insert into public.gateway_imported_usage_events
  (org_id, record_hash, batch_id, import_source, model_raw, alias, provider,
   model_matched, input_tokens, output_tokens, cached_input_tokens,
   reasoning_tokens, estimated_cost_micro_usd, occurred_at, day)
values
  -- Second matched Claude turn: same rollup as the re-imported preview row.
  ('62000000-0000-0000-0000-000000000001', repeat('b', 64), 'batch-3',
   'claude-code', 'claude-opus-4-8', 'claude-opus-4-8', 'anthropic', true,
   200, 80, 20, 5, 1500, now(), (now() at time zone 'UTC')::date),
  -- Unmatched: groups on the raw string even if an alias is present.
  ('62000000-0000-0000-0000-000000000001', repeat('c', 64), 'batch-3',
   'codex', 'o4-mini', 'should-be-ignored', null, false,
   50, 10, 0, 0, 0, now(), (now() at time zone 'UTC')::date),
  -- Lower spend than the aggregated Claude group (3000).
  ('62000000-0000-0000-0000-000000000001', repeat('d', 64), 'batch-3',
   'codex', 'gpt-5.6-sol', 'gpt-5.6-sol', 'openai', true,
   300, 60, 0, 0, 2000, now(), (now() at time zone 'UTC')::date),
  -- Other tenant: must never surface for org A.
  ('62000000-0000-0000-0000-000000000002', repeat('e', 64), 'batch-x',
   'claude-code', 'other-org-only', 'other-org-only', 'anthropic', true,
   999, 999, 0, 0, 99000, now(), (now() at time zone 'UTC')::date);

select is(
  (select count(*)::int from public.gateway_imported_usage_by_model(
    '62000000-0000-0000-0000-000000000001'
  )),
  3,
  'one rollup row per (source, model) for the org'
);

select results_eq(
  $$select model, model_matched, request_count, input_tokens, output_tokens,
           cached_input_tokens, reasoning_tokens, estimated_cost_micro_usd
      from public.gateway_imported_usage_by_model(
        '62000000-0000-0000-0000-000000000001'
      )
     where model = 'claude-opus-4-8'$$,
  $$values (
    'claude-opus-4-8'::text, true, 2::bigint, 200::bigint, 80::bigint,
    20::bigint, 5::bigint, 3000::bigint
  )$$,
  'matched turns group on the catalog alias and sum tokens and cost'
);

select results_eq(
  $$select model, model_matched, request_count, estimated_cost_micro_usd
      from public.gateway_imported_usage_by_model(
        '62000000-0000-0000-0000-000000000001'
      )
     where import_source = 'codex' and model_matched is false$$,
  $$values ('o4-mini'::text, false, 1::bigint, 0::bigint)$$,
  'unmatched turns group on the raw model string, not a leftover alias'
);

select is(
  (select count(*)::int from public.gateway_imported_usage_by_model(
    '62000000-0000-0000-0000-000000000001'
  ) where model = 'other-org-only'),
  0,
  'the rollup never includes another organization''s turns'
);

select results_eq(
  $$select model from public.gateway_imported_usage_by_model(
    '62000000-0000-0000-0000-000000000001'
  )$$,
  $$values ('claude-opus-4-8'::text), ('gpt-5.6-sol'::text), ('o4-mini'::text)$$,
  'order is attributed spend desc, then request count desc, then source/model'
);

-- Cascade: deleting the org clears its imported history.
delete from public.organizations where id = '62000000-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.gateway_imported_usage_events
     where org_id = '62000000-0000-0000-0000-000000000001'),
  0,
  'imported rows cascade-delete with the org'
);

select * from finish();

rollback;
