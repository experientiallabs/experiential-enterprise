begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

-- ---------------------------------------------------------------------------
-- E7 audit log: record_audit_event is the only write path, the table is
-- append-only for every role including its owner, and audit_log_read is the
-- org-scoped filtered reader. All ids are prefixed '73...' so ambient seed
-- data cannot perturb the assertions. No organizations fixture on purpose:
-- audit_log.org_id carries no FK (audit history survives org deletion).

create temporary table audit_ids (k text primary key, v text);

-- ---------------------------------------------------------------------------
-- 1. Writer RPC inserts and returns the event id.

insert into audit_ids
select 'e1', public.record_audit_event(
  '73000000-0000-0000-0000-000000000001',
  'user',
  '73000000-0000-0000-0000-0000000000aa',
  'keys.revoke',
  'api_key',
  'k-audit-1',
  '{"name": "old"}'::jsonb,
  '{"name": "new"}'::jsonb,
  '{"ip": "203.0.113.7"}'::jsonb
)::text;

select is(
  (select count(*)::int from public.audit_log
   where event_id = (select v::uuid from audit_ids where k = 'e1')),
  1,
  'record_audit_event inserts one row and returns its event id'
);

select results_eq(
  $$select actor_kind, actor_id, action, object_type, object_id,
           before ->> 'name', after ->> 'name', context ->> 'ip'
      from public.audit_log
     where event_id = (select v::uuid from audit_ids where k = 'e1')$$,
  $$values ('user'::text, '73000000-0000-0000-0000-0000000000aa'::text,
            'keys.revoke'::text, 'api_key'::text, 'k-audit-1'::text,
            'old'::text, 'new'::text, '203.0.113.7'::text)$$,
  'the event row carries actor, action, object, snapshots, and context'
);

-- Distinct created_at for the ordering / in_before assertions below.
select pg_sleep(0.01);

-- Omitted optional params: before/after stay null, context coalesces to {}.
insert into audit_ids
select 'e2', public.record_audit_event(
  '73000000-0000-0000-0000-000000000001',
  'platform_admin',
  '73000000-0000-0000-0000-0000000000bb',
  'aliases.repoint',
  'alias',
  'coding'
)::text;

select is(
  (select context from public.audit_log
   where event_id = (select v::uuid from audit_ids where k = 'e2')),
  '{}'::jsonb,
  'a null context coalesces to the empty object'
);

select pg_sleep(0.01);

insert into audit_ids
select 'e3', public.record_audit_event(
  '73000000-0000-0000-0000-000000000001',
  'api_key',
  'k-audit-1',
  'keys.revoke',
  'api_key',
  'k-audit-2'
)::text;

-- Another org's event must never surface in the first org's reads.
insert into audit_ids
select 'e4', public.record_audit_event(
  '73000000-0000-0000-0000-000000000002',
  'system',
  null,
  'orgs.delete',
  'organization',
  '73000000-0000-0000-0000-000000000002'
)::text;

-- ---------------------------------------------------------------------------
-- 2. Invalid actors are refused with a typed error.

select throws_ok(
  $$select public.record_audit_event(
    null, 'superuser', null, 'keys.revoke', 'api_key', 'k-x')$$,
  '23514',
  null,
  'an unknown actor_kind is refused'
);

select throws_ok(
  $$select public.record_audit_event(
    null, null, null, 'keys.revoke', 'api_key', 'k-x')$$,
  '23514',
  null,
  'a null actor_kind is refused'
);

-- ---------------------------------------------------------------------------
-- 3. Append-only for everyone: this session runs as the table owner
--    (postgres), which the trigger blocks like any other role.

select throws_ok(
  $$update public.audit_log set action = 'tampered'
    where event_id = (select v::uuid from audit_ids where k = 'e1')$$,
  'P0001',
  null,
  'audit rows cannot be updated, even by the table owner'
);

select throws_ok(
  $$delete from public.audit_log
    where event_id = (select v::uuid from audit_ids where k = 'e1')$$,
  'P0001',
  null,
  'audit rows cannot be deleted, even by the table owner'
);

-- ---------------------------------------------------------------------------
-- 4. Privilege posture: service_role reads only (writes go through the RPC);
--    authenticated has no path to the table or the RPCs at all.

select ok(
  not has_table_privilege('service_role', 'public.audit_log', 'insert'),
  'service role cannot insert audit rows directly'
);

select ok(
  not has_table_privilege('service_role', 'public.audit_log', 'update'),
  'service role cannot update audit rows'
);

select ok(
  not has_table_privilege('service_role', 'public.audit_log', 'delete'),
  'service role cannot delete audit rows'
);

select ok(
  has_table_privilege('service_role', 'public.audit_log', 'select'),
  'service role reads the audit log'
);

select ok(
  not has_table_privilege('authenticated', 'public.audit_log', 'select'),
  'authenticated cannot read the audit log directly'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_audit_event(uuid, text, text, text, text, text, jsonb, jsonb, jsonb)',
    'execute'
  ),
  'authenticated cannot execute record_audit_event'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.audit_log_read(uuid, text, text, text, timestamptz, integer)',
    'execute'
  ),
  'authenticated cannot execute audit_log_read'
);

set local role authenticated;

select throws_ok(
  $$select count(*) from public.audit_log$$,
  '42501',
  null,
  'an authenticated session cannot select the audit log'
);

select throws_ok(
  $$select public.record_audit_event(
    null, 'user', null, 'keys.revoke', 'api_key', 'k-x')$$,
  '42501',
  null,
  'an authenticated session cannot emit audit events'
);

select throws_ok(
  $$select * from public.audit_log_read(
    '73000000-0000-0000-0000-000000000001')$$,
  '42501',
  null,
  'an authenticated session cannot read through the reader RPC'
);

reset role;

-- ---------------------------------------------------------------------------
-- 5. Reader RPC: org scoping, filters, ordering, and the limit clamp.

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000001')),
  3,
  'the reader returns exactly the org''s events'
);

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000002')),
  1,
  'another org''s read sees only its own event'
);

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000001', in_action => 'keys.revoke')),
  2,
  'the action filter narrows the result'
);

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000001', in_object_type => 'alias')),
  1,
  'the object_type filter narrows the result'
);

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000001', in_actor_id => 'k-audit-1')),
  1,
  'the actor_id filter narrows the result'
);

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000001',
    in_before => (select created_at from public.audit_log
                  where event_id = (select v::uuid from audit_ids where k = 'e2')))),
  1,
  'in_before keeps strictly earlier events only'
);

select is(
  (select event_id::text from public.audit_log_read(
    '73000000-0000-0000-0000-000000000001') limit 1),
  (select v from audit_ids where k = 'e3'),
  'events return newest first'
);

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000001', in_limit => 0)),
  1,
  'a non-positive limit clamps up to one row'
);

select throws_ok(
  $$select * from public.audit_log_read(null)$$,
  '22023',
  null,
  'the reader requires an organization id'
);

-- Clamp ceiling: 210 events in a third org can never come back in one page.
do $$
begin
  perform public.record_audit_event(
    '73000000-0000-0000-0000-000000000003', 'system', null,
    'bulk.seed', 'thing', gs::pg_catalog.text)
  from pg_catalog.generate_series(1, 210) gs;
end;
$$;

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000003', in_limit => 1000)),
  200,
  'the limit clamps down to 200'
);

select is(
  (select count(*)::int from public.audit_log_read(
    '73000000-0000-0000-0000-000000000003')),
  50,
  'the default page is 50 events'
);

-- ---------------------------------------------------------------------------
-- 6. The viewer's two read shapes are indexed.

select has_index(
  'public', 'audit_log', 'audit_log_org_created_idx',
  'per-org newest-first reads are indexed'
);

select has_index(
  'public', 'audit_log', 'audit_log_org_action_created_idx',
  'per-org per-action reads are indexed'
);

select * from finish();

rollback;
