begin;

create extension if not exists pgtap with schema extensions;

select plan(85);

-- Scratch storage for ids captured from write-path functions.
create temporary table gw_ids (k text primary key, v text);

-- ---------------------------------------------------------------------------
-- Fixtures. Org A holds the $20 welcome grant (free-credit funded); org B is
-- drained to a zero balance. Keys k1/k2 attribute to one user, k3/kb to none.

insert into public.organizations (id, slug, name) values
  ('61000000-0000-0000-0000-000000000001', 'pgtap-gw-tenant-a', 'pgTAP Gateway A'),
  ('61000000-0000-0000-0000-000000000002', 'pgtap-gw-tenant-b', 'pgTAP Gateway B');

update public.organizations
   set billable_spend_usd = credit_granted_usd
 where id = '61000000-0000-0000-0000-000000000002';

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('61000000-0000-0000-0000-000000000011', '61000000-0000-0000-0000-000000000001',
   'gw-k1', 'xpl_gwk1', encode(sha256('gw-k1'::bytea), 'hex'),
   '61000000-0000-0000-0000-0000000000aa'),
  ('61000000-0000-0000-0000-000000000012', '61000000-0000-0000-0000-000000000001',
   'gw-k2', 'xpl_gwk2', encode(sha256('gw-k2'::bytea), 'hex'),
   '61000000-0000-0000-0000-0000000000aa'),
  ('61000000-0000-0000-0000-000000000013', '61000000-0000-0000-0000-000000000001',
   'gw-k3', 'xpl_gwk3', encode(sha256('gw-k3'::bytea), 'hex'), null),
  ('61000000-0000-0000-0000-000000000021', '61000000-0000-0000-0000-000000000002',
   'gw-kb', 'xpl_gwkb', encode(sha256('gw-kb'::bytea), 'hex'), null);

-- ---------------------------------------------------------------------------
-- 1. Catalog snapshots are content-addressed and immutable.

select is(
  (select changed from public.gateway_register_catalog_snapshot(
    repeat('ab', 32), '{"deployments": ["dep-1"]}'::jsonb, '{"models": []}'::jsonb
  )),
  true,
  'registering a new catalog snapshot reports a change'
);

select is(
  (select changed from public.gateway_register_catalog_snapshot(
    repeat('ab', 32), '{"deployments": ["dep-1"]}'::jsonb, '{"models": []}'::jsonb
  )),
  false,
  'replaying an identical snapshot registration is a no-op receipt'
);

select throws_ok(
  $$select * from public.gateway_register_catalog_snapshot(
    repeat('ab', 32), '{"deployments": ["dep-2"]}'::jsonb, '{"models": []}'::jsonb
  )$$,
  '23505',
  null,
  'different content under an existing digest is refused'
);

select throws_ok(
  $$update public.gateway_catalog_snapshots
    set document = '{}'::jsonb where catalog_sha256 = repeat('ab', 32)$$,
  'P0001',
  null,
  'catalog snapshots cannot be updated'
);

select throws_ok(
  $$delete from public.gateway_catalog_snapshots
    where catalog_sha256 = repeat('ab', 32)$$,
  'P0001',
  null,
  'catalog snapshots cannot be deleted'
);

-- Cold-boot race: two workers registering the same NEW digest must both
-- succeed. Registration is insert-first with ON CONFLICT, so the loser's
-- insert lands on the conflict and returns a no-op receipt — the second
-- call below drives exactly the code path a concurrent loser takes.
select is(
  (select changed from public.gateway_register_catalog_snapshot(
    repeat('ef', 32), '{"deployments": ["dep-cold"]}'::jsonb, '{"models": []}'::jsonb
  )),
  true,
  'the first cold-boot registration of a new digest wins'
);

select is(
  (select changed from public.gateway_register_catalog_snapshot(
    repeat('ef', 32), '{"deployments": ["dep-cold"]}'::jsonb, '{"models": []}'::jsonb
  )),
  false,
  'the losing cold-boot registration lands on the conflict and still succeeds'
);

select is(
  (select count(*) from public.gateway_catalog_snapshots
   where catalog_sha256 = repeat('ef', 32)),
  1::bigint,
  'racing same-digest registrations leave exactly one snapshot row'
);

-- ---------------------------------------------------------------------------
-- 2. Alias activation is idempotent; revisions are immutable.

select is(
  (select changed from public.gateway_activate_alias_revision(
    'alias-gpt-test', 'gpt-test', null, 'rev-1',
    '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null
  )),
  true,
  'activating a new alias revision reports a change'
);

select is(
  (select changed from public.gateway_activate_alias_revision(
    'alias-gpt-test', 'gpt-test', null, 'rev-1',
    '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null
  )),
  false,
  're-activating the active revision is a no-op receipt'
);

select throws_ok(
  $$select * from public.gateway_activate_alias_revision(
    'alias-gpt-test', 'gpt-test', null, 'rev-1',
    '{"pool_id": "pool-1", "deployment_ids": ["dep-9"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null
  )$$,
  '23505',
  null,
  'different content under an existing revision id is refused'
);

select is(
  (select changed from public.gateway_activate_alias_revision(
    'alias-gpt-test', 'gpt-test', null, 'rev-2',
    '{"pool_id": "pool-1", "deployment_ids": ["dep-1", "dep-2"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb,
    '{"certification_id": "cert-1", "provenance": "platform:model_waterfalls"}'::jsonb
  )),
  true,
  'a new revision id activates'
);

select is(
  (select current_revision_id from public.gateway_aliases
   where alias_id = 'alias-gpt-test'),
  'rev-2',
  'activation moves the current-revision pointer'
);

select throws_ok(
  $$update public.gateway_alias_revisions
    set target = '{}'::jsonb where revision_id = 'rev-1'$$,
  'P0001',
  null,
  'alias revisions cannot be mutated'
);

select is(
  (select changed from public.gateway_activate_alias_revision(
    'alias-gpt-test', 'gpt-test', null, 'rev-1',
    '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null
  )),
  true,
  're-activating a prior revision moves the pointer back and reports a change'
);

select throws_ok(
  $$select * from public.gateway_activate_alias_revision(
    'alias-other', 'gpt-test', null, 'rev-9',
    '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null
  )$$,
  '23505',
  null,
  'an alias name cannot bind to a second alias id in the same namespace'
);

-- Names are per-namespace: an org's custom model may reuse a public slug
-- and shadows it for that org's keys.
select is(
  (select changed from public.gateway_activate_alias_revision(
    'alias-org-shadow', 'gpt-test', '61000000-0000-0000-0000-000000000001',
    'rev-org-1',
    '{"pool_id": "pool-org", "deployment_ids": ["dep-org"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null
  )),
  true,
  'an org-scoped alias may shadow a public slug of the same name'
);

-- Deactivation retires a slug from routing without touching its history.
select is(
  (select changed from public.gateway_activate_alias_revision(
    'alias-retire', 'retire-test', null, 'rev-ret-1',
    '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null
  )),
  true,
  'a retirement fixture alias activates'
);

select is(
  (select changed from public.gateway_deactivate_alias('alias-retire')),
  true,
  'deactivating an active alias reports a change'
);

select is(
  (select changed from public.gateway_deactivate_alias('alias-retire')),
  false,
  'deactivating an inactive alias is a no-op receipt'
);

select is(
  (select active from public.gateway_aliases where alias_id = 'alias-retire'),
  false,
  'the deactivated alias is out of routing'
);

select is(
  (select changed from public.gateway_activate_alias_revision(
    'alias-retire', 'retire-test', null, 'rev-ret-1',
    '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null
  )),
  true,
  're-activating the same revision brings a retired alias back'
);

select throws_ok(
  $$select * from public.gateway_deactivate_alias('alias-missing')$$,
  'P0002',
  null,
  'deactivating an unknown alias fails loudly'
);

-- ---------------------------------------------------------------------------
-- 3. Request acceptance and caller-operation idempotency.

select lives_ok(
  $$select public.gateway_accept_request(
    'r-1', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-1'::bytea), 'hex'),
    encode(sha256('op-1'::bytea), 'hex'), now() + interval '1 hour'
  )$$,
  'a keyed request is accepted'
);

select throws_ok(
  $$select public.gateway_accept_request(
    'r-2', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-DIFFERENT'::bytea), 'hex'),
    encode(sha256('op-1'::bytea), 'hex'), now() + interval '1 hour'
  )$$,
  'P1020',
  null,
  'reusing a caller operation key with different content is a conflict'
);

select throws_ok(
  $$select public.gateway_accept_request(
    'r-3', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-1'::bytea), 'hex'),
    encode(sha256('op-1'::bytea), 'hex'), now() + interval '1 hour'
  )$$,
  'P1021',
  null,
  'a matching keyed request without durable replay is refused honestly'
);

select lives_ok(
  $$select public.gateway_accept_request(
    'r-1', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-1'::bytea), 'hex'),
    encode(sha256('op-1'::bytea), 'hex'), now() + interval '1 hour'
  )$$,
  'replaying an identical accept for the same request id is a no-op receipt'
);

select throws_ok(
  $$select public.gateway_accept_request(
    'r-1', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-DIFFERENT'::bytea), 'hex'),
    encode(sha256('op-1'::bytea), 'hex'), now() + interval '1 hour'
  )$$,
  '23505',
  null,
  'a request id bound to different accepted content is a typed conflict'
);

-- Crashed-owner liveness: a prior stuck at terminal_state IS NULL past its own
-- deadline (owner died before publishing and before the crash reconciler ran)
-- is reclaimable, so a taken-over retry may re-dispatch instead of P1021-ing
-- for up to the reconcile interval. A still-in-flight NULL prior (deadline in
-- the future) and a genuinely completed prior stay fail-closed — the money
-- guarantee is unchanged.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, caller_operation_sha256, accepted_at, deadline_at,
  terminal_state, terminal_at
) values (
  'r-crash-null-past', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-crash'::bytea), 'hex'),
  encode(sha256('op-crash-null-past'::bytea), 'hex'),
  now() - interval '2 minutes', now() - interval '1 minute', null, null
);
select lives_ok(
  $$select public.gateway_accept_request(
    'r-crash-null-past-retry', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-crash'::bytea), 'hex'),
    encode(sha256('op-crash-null-past'::bytea), 'hex'), now() + interval '1 hour'
  )$$,
  'a never-terminal prior past its deadline is reclaimable: the retry re-dispatches'
);
-- Settle the reclaimed prior the way the crash reconciler would (fixture
-- surgery), so it stops being open pre-dispatch work that section 6's
-- reconcile counts pick up alongside their own fixtures.
update public.gateway_requests
   set terminal_state = 'expired_before_dispatch',
       terminal_at = now()
 where request_id = 'r-crash-null-past';

insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, caller_operation_sha256, accepted_at, deadline_at,
  terminal_state, terminal_at
) values (
  'r-inflight-null-future', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-inflight'::bytea), 'hex'),
  encode(sha256('op-inflight-null-future'::bytea), 'hex'),
  now(), now() + interval '1 hour', null, null
);
select throws_ok(
  $$select public.gateway_accept_request(
    'r-inflight-null-future-retry', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-inflight'::bytea), 'hex'),
    encode(sha256('op-inflight-null-future'::bytea), 'hex'), now() + interval '1 hour'
  )$$,
  'P1021',
  null,
  'a still-in-flight NULL prior within its deadline stays fail-closed'
);

insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, caller_operation_sha256, accepted_at, deadline_at,
  terminal_state, terminal_at
) values (
  'r-completed-past', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-completed'::bytea), 'hex'),
  encode(sha256('op-completed-past'::bytea), 'hex'),
  now() - interval '2 minutes', now() - interval '1 minute',
  'completed', now() - interval '1 minute'
);
select throws_ok(
  $$select public.gateway_accept_request(
    'r-completed-past-retry', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-completed'::bytea), 'hex'),
    encode(sha256('op-completed-past'::bytea), 'hex'), now() + interval '1 hour'
  )$$,
  'P1021',
  null,
  'a completed prior past its deadline still refuses re-dispatch (money guarantee)'
);

-- ---------------------------------------------------------------------------
-- 4. Money: lanes, caps, rate guard, reservations, zero-completion insurance.

-- BYOK is never blocked, even at a zero balance.
select public.gateway_accept_request(
  'r-b1', '61000000-0000-0000-0000-000000000002',
  '61000000-0000-0000-0000-000000000021', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-b1'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select lives_ok(
  $$select * from public.gateway_start_attempt(
    'r-b1', '61000000-0000-0000-0000-000000000002', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'customer_managed', null, null, null, null, null, null, null
  )$$,
  'a pass-through attempt dispatches with a zero org balance'
);

-- The platform-funded lane blocks at a zero balance.
select public.gateway_accept_request(
  'r-b2', '61000000-0000-0000-0000-000000000002',
  '61000000-0000-0000-0000-000000000021', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-b2'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-b2', '61000000-0000-0000-0000-000000000002', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000
  )$$,
  'P1010',
  null,
  'a platform-funded attempt at a zero balance is refused with the org scope'
);

-- An unknown-priced route is ineligible while a hard cap applies
-- (deployment scope: the waterfall may advance).
select public.gateway_accept_request(
  'r-a1', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-a1'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select public.gateway_accept_request(
  'r-a2', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-a2'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-a1', '61000000-0000-0000-0000-000000000001', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', null, null, null, null, null, null, null
  )$$,
  'P1013',
  null,
  'an unpriced platform-funded route under a cap is ineligible'
);

-- Explicit per-key daily cap.
insert into public.gateway_key_limits (api_key_id, daily_spend_cap_micro_usd, requests_per_minute)
values ('61000000-0000-0000-0000-000000000012', 5000000, 100);

select public.gateway_accept_request(
  'r-k2a', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000012', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-k2a'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select public.gateway_accept_request(
  'r-k2b', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000012', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-k2b'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-k2a', '61000000-0000-0000-0000-000000000001', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 6000000
  )$$,
  'P1011',
  null,
  'a worst case above the key daily cap is refused with the key scope'
);

insert into gw_ids
select 'a_k2_1', s.attempt_id from public.gateway_start_attempt(
  'r-k2a', '61000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  2000000, null, 10000000, null, 5000000
) s;

select is(
  (select state from public.gateway_attempts
   where attempt_id = (select v from gw_ids where k = 'a_k2_1')),
  'dispatched',
  'a worst case at exactly the key daily cap is admitted'
);

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-k2b', '61000000-0000-0000-0000-000000000001', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1
  )$$,
  'P1011',
  null,
  'outstanding reservations count against the key daily cap'
);

-- Zero-completion insurance releases the cap headroom too.
select public.gateway_settle_attempt(
  (select v from gw_ids where k = 'a_k2_1'), 'failed', 'provider_error',
  null, null, null, null, 'unknown', false
);

select is(
  (select budget_settled_micro_usd from public.gateway_attempts
   where attempt_id = (select v from gw_ids where k = 'a_k2_1')),
  0::bigint,
  'a terminally failed platform-funded attempt settles at zero'
);

insert into gw_ids
select 'a_k2_2', s.attempt_id from public.gateway_start_attempt(
  'r-k2b', '61000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  2000000, null, 10000000, null, 5000000
) s;

select is(
  (select state from public.gateway_attempts
   where attempt_id = (select v from gw_ids where k = 'a_k2_2')),
  'dispatched',
  'settling at zero released the reservation: the freed cap headroom admits again'
);

select public.gateway_settle_attempt(
  (select v from gw_ids where k = 'a_k2_2'), 'failed', 'provider_error',
  null, null, null, null, 'unknown', false
);

-- Request-rate guard counts platform-funded dispatches only: acceptance and
-- BYOK traffic never move the counter.
insert into public.gateway_key_limits (api_key_id, daily_spend_cap_micro_usd, requests_per_minute)
values ('61000000-0000-0000-0000-000000000013', null, 1);

select public.gateway_accept_request(
  'r-k3a', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000013', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-k3a'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select public.gateway_accept_request(
  'r-k3b', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000013', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-k3b'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

insert into gw_ids
select 'a_k3', s.attempt_id from public.gateway_start_attempt(
  'r-k3a', '61000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  2000000, null, 10000000, null, 1000
) s;

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-k3b', '61000000-0000-0000-0000-000000000001', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000
  )$$,
  'P1012',
  null,
  'a second platform-funded dispatch inside the minute is refused'
);

select lives_ok(
  $$select * from public.gateway_start_attempt(
    'r-k3b', '61000000-0000-0000-0000-000000000001', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'customer_managed', null, null, null, null, null, null, null
  )$$,
  'BYOK dispatch neither counts against nor hits the rate guard'
);

-- Release the exhausted key's reservation so later balance math stays exact.
select public.gateway_settle_attempt(
  (select v from gw_ids where k = 'a_k3'), 'failed', 'provider_error',
  null, null, null, null, 'unknown', false
);

-- One honest overdraft: a positive balance admits a worst case that exceeds
-- it, and the outstanding reservation then blocks everything after it.
insert into gw_ids
select 'a_1', s.attempt_id from public.gateway_start_attempt(
  'r-a1', '61000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  2000000, null, 10000000, null, 25000000
) s;

select is(
  (select state from public.gateway_attempts
   where attempt_id = (select v from gw_ids where k = 'a_1')),
  'dispatched',
  'a positive balance admits a worst case exceeding it (one honest overdraft)'
);

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-a2', '61000000-0000-0000-0000-000000000001', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000
  )$$,
  'P1010',
  null,
  'outstanding reservations exhaust the balance: no second over-reservation'
);

select public.gateway_settle_attempt(
  (select v from gw_ids where k = 'a_1'), 'failed', 'provider_error',
  null, null, null, null, 'unknown', true
);

select is(
  (select billable_spend_usd from public.organizations
   where id = '61000000-0000-0000-0000-000000000001'),
  0.000000::numeric,
  'zero-completion insurance: a failed attempt never draws down credits'
);

select results_eq(
  $$select cost_micro_usd, status, attempt_count, lane
    from public.gateway_usage_events where request_id = 'r-a1'$$,
  $$values (0::bigint, 'failed'::text, 1, 'platform_funded'::text)$$,
  'the failed request settles into a zero-cost usage event'
);

insert into gw_ids
select 'a_2', s.attempt_id from public.gateway_start_attempt(
  'r-a2', '61000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  2000000, null, 10000000, null, 1000000
) s;

select is(
  (select state from public.gateway_attempts
   where attempt_id = (select v from gw_ids where k = 'a_2')),
  'dispatched',
  'releasing the failed reservation restores balance headroom'
);

select public.gateway_settle_attempt(
  (select v from gw_ids where k = 'a_2'), 'completed', null,
  1000, 0, 500, 0, 'observed', true
);

select is(
  (select budget_settled_micro_usd from public.gateway_attempts
   where attempt_id = (select v from gw_ids where k = 'a_2')),
  7000::bigint,
  'a completed attempt settles at observed tokens times frozen rates'
);

select is(
  (select billable_spend_usd from public.organizations
   where id = '61000000-0000-0000-0000-000000000001'),
  0.007000::numeric,
  'the settled cost draws down platform credits exactly'
);

select results_eq(
  $$select provider, lane, input_tokens, output_tokens, cost_micro_usd,
           estimated_cost_micro_usd, status, attempt_count, user_id
    from public.gateway_usage_events where request_id = 'r-a2'$$,
  $$values ('prov-openai'::text, 'platform_funded'::text, 1000::bigint,
            500::bigint, 7000::bigint, 0::bigint, 'completed'::text, 1,
            '61000000-0000-0000-0000-0000000000aa'::uuid)$$,
  'the completed request settles into an exact usage event'
);

select results_eq(
  $$select requests, input_tokens, output_tokens, spend_micro_usd
    from public.gateway_usage_daily
    where org_id = '61000000-0000-0000-0000-000000000001'
      and user_id = '61000000-0000-0000-0000-0000000000aa'
      and alias = 'gpt-test'$$,
  $$values (2::bigint, 1000::bigint, 500::bigint, 7000::bigint)$$,
  'the daily rollup sums the user''s finished requests'
);

select lives_ok(
  $$select public.gateway_settle_attempt(
    (select v from gw_ids where k = 'a_2'), 'completed', null,
    1000, 0, 500, 0, 'observed', true
  )$$,
  'replaying a settlement with the same terminal state is a no-op'
);

select is(
  (select requests from public.gateway_usage_daily
   where org_id = '61000000-0000-0000-0000-000000000001'
     and user_id = '61000000-0000-0000-0000-0000000000aa'
     and alias = 'gpt-test'),
  2::bigint,
  'a replayed settlement never double-counts the rollup'
);

select public.gateway_accept_request(
  'r-a3', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-a3'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
insert into gw_ids
select 'a_3', s.attempt_id from public.gateway_start_attempt(
  'r-a3', '61000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  2000000, null, 10000000, null, 1000000
) s;
select public.gateway_settle_attempt(
  (select v from gw_ids where k = 'a_3'), 'completed', null,
  1000, 0, 500, 0, 'observed', true
);

select results_eq(
  $$select requests, input_tokens, output_tokens, spend_micro_usd
    from public.gateway_usage_daily
    where org_id = '61000000-0000-0000-0000-000000000001'
      and user_id = '61000000-0000-0000-0000-0000000000aa'
      and alias = 'gpt-test'$$,
  $$values (3::bigint, 2000::bigint, 1000::bigint, 14000::bigint)$$,
  'a second completed request increments every rollup counter'
);

select is(
  (select billable_spend_usd from public.organizations
   where id = '61000000-0000-0000-0000-000000000001'),
  0.014000::numeric,
  'credits draw down once per settled request'
);

-- ---------------------------------------------------------------------------
-- 5. Pre-dispatch termination.

select public.gateway_accept_request(
  'r-f', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000013', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-f'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select public.gateway_finish_request(
  'r-f', '61000000-0000-0000-0000-000000000001', 'failed'
);

select results_eq(
  $$select cost_micro_usd, provider, lane, attempt_count, status, user_id
    from public.gateway_usage_events where request_id = 'r-f'$$,
  $$values (0::bigint, null::text, null::text, 0, 'failed'::text, null::uuid)$$,
  'a request that never dispatched settles into a zero-cost laneless event'
);

select is(
  (select requests from public.gateway_usage_daily
   where org_id = '61000000-0000-0000-0000-000000000001'
     and user_id = '00000000-0000-0000-0000-000000000000'
     and alias = 'gpt-test'),
  1::bigint,
  'a creatorless key buckets its rollup under the zero uuid'
);

select lives_ok(
  $$select public.gateway_finish_request(
    'r-f', '61000000-0000-0000-0000-000000000001', 'failed'
  )$$,
  'replaying a pre-dispatch finish with the same state is a no-op'
);

select throws_ok(
  $$select public.gateway_finish_request(
    'r-f', '61000000-0000-0000-0000-000000000001', 'cancelled'
  )$$,
  '23514',
  null,
  'a settled request refuses a different terminal state'
);

-- ---------------------------------------------------------------------------
-- 6. Crash reconciliation is explicit, insured, and idempotent.

select public.gateway_accept_request(
  'r-x', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-x'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select public.gateway_accept_request(
  'r-y', '61000000-0000-0000-0000-000000000002',
  '61000000-0000-0000-0000-000000000021', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-y'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
insert into gw_ids
select 'a_y', s.attempt_id from public.gateway_start_attempt(
  'r-y', '61000000-0000-0000-0000-000000000002', 0, 0,
  'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'customer_managed', null, null, null, null, null, null, 3000000
) s;

-- Simulate the crash: both requests are now past their deadline (superuser
-- fixture surgery; the sanctioned write paths never move a deadline).
update public.gateway_requests
   set deadline_at = now() - interval '2 minutes'
 where request_id in ('r-x', 'r-y');

select is(
  (select s.attempt_id from public.gateway_start_attempt(
    'r-y', '61000000-0000-0000-0000-000000000002', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'customer_managed', null, null, null, null, null, null, 3000000
  ) s),
  (select v from gw_ids where k = 'a_y'),
  'replaying a dispatch RPC returns the durable attempt id without re-reserving'
);

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-x', '61000000-0000-0000-0000-000000000001', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'customer_managed', null, null, null, null, null, null, null
  )$$,
  '23514',
  null,
  'a new dispatch past the request deadline is refused'
);

select results_eq(
  'select * from public.gateway_reconcile_crashed(30)',
  $$values (1, 1)$$,
  'the reconciler expires one pre-dispatch request and orphans one attempt'
);

select results_eq(
  $$select status, cost_micro_usd, lane, attempt_count
    from public.gateway_usage_events where request_id = 'r-x'$$,
  $$values ('expired_before_dispatch'::text, 0::bigint, null::text, 0)$$,
  'an expired pre-dispatch request emits a zero-cost usage event'
);

select results_eq(
  $$select state, budget_settled_micro_usd, estimated_cost_micro_usd, usage_source
    from public.gateway_attempts
    where attempt_id = (select v from gw_ids where k = 'a_y')$$,
  $$values ('unknown_after_crash'::text, 3000000::bigint, 3000000::bigint,
            'unknown'::text)$$,
  'an orphaned pass-through attempt keeps its reserved amount as the estimate'
);

select results_eq(
  $$select status, lane, cost_micro_usd, estimated_cost_micro_usd
    from public.gateway_usage_events where request_id = 'r-y'$$,
  $$values ('unknown_after_crash'::text, 'pass_through'::text, 0::bigint,
            3000000::bigint)$$,
  'the crashed request charges nothing and lands its estimate separately'
);

select results_eq(
  'select * from public.gateway_reconcile_crashed(30)',
  $$values (0, 0)$$,
  'a second reconcile pass changes nothing'
);

select is(
  (select requests from public.gateway_usage_daily
   where org_id = '61000000-0000-0000-0000-000000000002'
     and user_id = '00000000-0000-0000-0000-000000000000'
     and alias = 'gpt-test'),
  1::bigint,
  'reconciliation never double-counts the rollup'
);

-- ---------------------------------------------------------------------------
-- 7. The canonical usage stream is append-only.

select throws_ok(
  $$update public.gateway_usage_events set cost_micro_usd = 999
    where request_id = 'r-a2'$$,
  'P0001',
  null,
  'usage events cannot be updated'
);

select throws_ok(
  $$delete from public.gateway_usage_events where request_id = 'r-a2'$$,
  'P0001',
  null,
  'usage events cannot be deleted (settled money history)'
);

-- ---------------------------------------------------------------------------
-- 8. Worker registry.

select public.gateway_worker_heartbeat('worker-1', 'starting', null, 'v-test');
insert into gw_ids
select 'w_started', started_at::text from public.gateway_workers
where worker_id = 'worker-1';

select is(
  (select state from public.gateway_workers where worker_id = 'worker-1'),
  'starting',
  'a first heartbeat registers the worker'
);

select public.gateway_worker_heartbeat(
  'worker-1', 'ready', repeat('ab', 32), 'v-test'
);

select ok(
  (select state = 'ready'
      and started_at::text = (select v from gw_ids where k = 'w_started')
      and heartbeat_at >= started_at
   from public.gateway_workers where worker_id = 'worker-1'),
  'a later heartbeat updates state and freshness but preserves start time'
);

-- ---------------------------------------------------------------------------
-- 9. Late finalize via settle replay, and the revocation backstops.

select lives_ok(
  $$select public.gateway_settle_attempt(
    (select v from gw_ids where k = 'a_k2_1'), 'failed', 'provider_error',
    null, null, null, null, 'unknown', true
  )$$,
  'replaying a matching settlement with finalize terminalizes an open request'
);

select results_eq(
  $$select status, cost_micro_usd, lane, attempt_count
    from public.gateway_usage_events where request_id = 'r-k2a'$$,
  $$values ('failed'::text, 0::bigint, 'platform_funded'::text, 1)$$,
  'the late finalize emits the missing usage event exactly once'
);

-- Mixed-lane request: a pass-through attempt fails over to a platform-funded
-- one; charged and estimated money stay split on the event.
select public.gateway_accept_request(
  'r-mix', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000012', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-mix'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
insert into gw_ids
select 'a_mix0', s.attempt_id from public.gateway_start_attempt(
  'r-mix', '61000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'customer_managed', null, null,
  2000000, null, 10000000, null, null
) s;
select public.gateway_settle_attempt(
  (select v from gw_ids where k = 'a_mix0'), 'failed', 'provider_error',
  1000, 0, 500, 0, 'observed', false
);
insert into gw_ids
select 'a_mix1', s.attempt_id from public.gateway_start_attempt(
  'r-mix', '61000000-0000-0000-0000-000000000001', 1, 1,
  'dep-2', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  2000000, null, 10000000, null, 1000000
) s;
select public.gateway_settle_attempt(
  (select v from gw_ids where k = 'a_mix1'), 'completed', null,
  1000, 0, 500, 0, 'observed', true
);

select results_eq(
  $$select lane, cost_micro_usd, estimated_cost_micro_usd, attempt_count, status
    from public.gateway_usage_events where request_id = 'r-mix'$$,
  $$values ('platform_funded'::text, 7000::bigint, 7000::bigint, 2,
            'completed'::text)$$,
  'a mixed-lane request keeps charged and estimated money split'
);

update public.api_keys set revoked_at = now()
 where id = '61000000-0000-0000-0000-000000000011';

select throws_ok(
  $$select public.gateway_accept_request(
    'r-rev', '61000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-1',
    'chat_completions', encode(sha256('req-rev'::bytea), 'hex'),
    null, now() + interval '1 hour'
  )$$,
  '42501',
  null,
  'a revoked key cannot accept new gateway requests'
);

select public.gateway_accept_request(
  'r-rev2', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000012', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-rev2'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

update public.api_keys set revoked_at = now()
 where id = '61000000-0000-0000-0000-000000000012';

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-rev2', '61000000-0000-0000-0000-000000000001', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000
  )$$,
  '42501',
  null,
  'a key revoked between accept and dispatch cannot start spending'
);

-- ---------------------------------------------------------------------------
-- 10. A key hard-delete detaches in-flight attribution (set null) but never
--     touches the settled money record.

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by)
values ('61000000-0000-0000-0000-000000000014',
        '61000000-0000-0000-0000-000000000001',
        'gw-k4', 'xpl_gwk4', encode(sha256('gw-k4'::bytea), 'hex'), null);
select public.gateway_accept_request(
  'r-del', '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000014', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-del'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select public.gateway_finish_request(
  'r-del', '61000000-0000-0000-0000-000000000001', 'failed'
);

select lives_ok(
  $$delete from public.api_keys
    where id = '61000000-0000-0000-0000-000000000014'$$,
  'a key with settled gateway history can be hard-deleted'
);

select is(
  (select api_key_id from public.gateway_requests where request_id = 'r-del'),
  null::uuid,
  'the deleted key detaches from its request (set null)'
);

select is(
  (select api_key_id from public.gateway_usage_events where request_id = 'r-del'),
  '61000000-0000-0000-0000-000000000014'::uuid,
  'the settled usage event keeps its key-id snapshot'
);

-- ---------------------------------------------------------------------------
-- 11. Privilege shape: the SQL functions are the only write paths.

select ok(
  not has_table_privilege('service_role', 'public.gateway_requests', 'insert'),
  'service role cannot write gateway_requests directly'
);

select ok(
  not has_table_privilege('service_role', 'public.gateway_attempts', 'update'),
  'service role cannot mutate gateway_attempts directly'
);

select ok(
  not has_table_privilege('service_role', 'public.gateway_usage_events', 'insert'),
  'service role cannot fabricate usage events directly'
);

select ok(
  has_table_privilege('service_role', 'public.gateway_key_limits', 'insert'),
  'key limits are control-API-writable settings'
);

select has_index(
  'public', 'gateway_usage_events', 'gateway_usage_events_created_idx',
  'usage events carry the cross-org trailing-window (created_at) index'
);

-- ---------------------------------------------------------------------------
-- Fail-closed: an unknown worst-case price is ineligible on the host lane even
-- with NO daily cap, so it can never slip the credit-balance gate and reserve
-- $0 (which would let settlement drive the balance negative). Org C is paid
-- (free-credit caps lifted -> not free-credit funded) with a positive balance
-- and a key with no limit, so v_cap is null and only the balance gate governs.

insert into public.organizations (id, slug, name, free_credit_caps_lifted_at) values
  ('61000000-0000-0000-0000-000000000003', 'pgtap-gw-tenant-c', 'pgTAP Gateway C', now());
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('61000000-0000-0000-0000-000000000031', '61000000-0000-0000-0000-000000000003',
   'gw-kc', 'xpl_gwkc', encode(sha256('gw-kc'::bytea), 'hex'), null);

select public.gateway_accept_request(
  'r-c1', '61000000-0000-0000-0000-000000000003',
  '61000000-0000-0000-0000-000000000031', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-c1'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select * from public.gateway_start_attempt(
    'r-c1', '61000000-0000-0000-0000-000000000003', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', null, null, null, null, null, null, null
  )$$,
  'P1013',
  null,
  'an unknown-priced host route with NO cap is ineligible (balance-protecting '
    || 'fail-closed): old coalesced the price to $0 and slipped the balance gate'
);

-- Positive control: the SAME no-cap org with a KNOWN price and headroom still
-- dispatches — the guard only bites unknown prices, not known ones.
select public.gateway_accept_request(
  'r-c2', '61000000-0000-0000-0000-000000000003',
  '61000000-0000-0000-0000-000000000031', 'gpt-test', 'rev-1',
  'chat_completions', encode(sha256('req-c2'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select lives_ok(
  $$select * from public.gateway_start_attempt(
    'r-c2', '61000000-0000-0000-0000-000000000003', 0, 0,
    'dep-1', 'prov-openai', 'gpt-test-exact', 'pool-1', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000
  )$$,
  'a known-priced host route with headroom and no cap still dispatches'
);

select * from finish();

rollback;
