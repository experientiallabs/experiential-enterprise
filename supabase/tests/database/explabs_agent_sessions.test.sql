begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

-- Fixture: two orgs (a member of the first), each with a project, world model,
-- and agent, so sessions have an attributable owner and RLS has a cross-org
-- resource to hide.
insert into public.organizations (id, slug, name)
values
  ('a0000000-0000-0000-0000-000000000001', 'sess-org-a', 'Session Org A'),
  ('a0000000-0000-0000-0000-000000000002', 'sess-org-b', 'Session Org B');

insert into public.organization_members (org_id, user_id, role)
values ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000091', 'user');

insert into public.world_models (id, org_id, name, display_name, status)
values (
  'a0000000-0000-0000-0000-000000000021', 'a0000000-0000-0000-0000-000000000001',
  'sess-model', 'Session Model', 'ready'
);

insert into public.agents (id, org_id, world_model_id, name, agent_provider, agent_model)
values
  ('a0000000-0000-0000-0000-000000000031', 'a0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000021', 'sess-agent-a', 'bedrock', 'glm-5'),
  ('a0000000-0000-0000-0000-000000000032', 'a0000000-0000-0000-0000-000000000002',
   'a0000000-0000-0000-0000-000000000021', 'sess-agent-b', 'bedrock', 'glm-5'),
  -- A second agent in org A, so admit_agent_session's org/global caps can be
  -- exercised against a fresh agent (no active session of its own to trip).
  ('a0000000-0000-0000-0000-000000000033', 'a0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000021', 'sess-agent-c', 'bedrock', 'glm-5');

update public.agents
set workspace_sandbox_id = 'sbx-persistent-a'
where id = 'a0000000-0000-0000-0000-000000000031';

select is(
  (select workspace_sandbox_id from public.agents
   where id = 'a0000000-0000-0000-0000-000000000031'),
  'sbx-persistent-a',
  'an agent stores one stable E2B workspace across live sessions'
);

-- fill_session_org: an insert without org_id backfills from the agent.
insert into public.agent_sessions (id, agent_id, harness_version, agent_provider, agent_model)
values (
  'a0000000-0000-0000-0000-000000000041', 'a0000000-0000-0000-0000-000000000031',
  0, 'bedrock', 'glm-5'
);

select is(
  (select org_id from public.agent_sessions
   where id = 'a0000000-0000-0000-0000-000000000041'),
  'a0000000-0000-0000-0000-000000000001'::uuid,
  'fill_session_org backfills org_id from the agent'
);

-- claim_agent_session: bumps the epoch while starting, returns null otherwise.
select is(
  public.claim_agent_session('a0000000-0000-0000-0000-000000000041', 'worker-1'),
  1,
  'claim bumps the epoch from 0 to 1 while starting'
);

-- append_session_event: gapless seq under the current epoch.
select is(
  public.append_session_event('a0000000-0000-0000-0000-000000000041', 1, 'assistant_message',
    '{"text": "hi"}'::jsonb),
  1::bigint,
  'the first event gets seq 1'
);

select is(
  public.append_session_event('a0000000-0000-0000-0000-000000000041', 1, 'tool_call',
    '{"name": "bash"}'::jsonb),
  2::bigint,
  'the next event gets seq 2 (gapless)'
);

-- A stale epoch (a zombie driver) is rejected, not written.
select throws_ok(
  $$ select public.append_session_event('a0000000-0000-0000-0000-000000000041', 0,
       'assistant_message', '{"text": "z"}'::jsonb) $$,
  'stale claim epoch for session a0000000-0000-0000-0000-000000000041',
  'a stale epoch append is rejected'
);

select is(
  (select count(*)::int from public.agent_session_events
   where session_id = 'a0000000-0000-0000-0000-000000000041'),
  2,
  'the rejected append wrote no event'
);

-- A running session cannot be claimed again.
update public.agent_sessions set status = 'running'
 where id = 'a0000000-0000-0000-0000-000000000041';

select is(
  public.claim_agent_session('a0000000-0000-0000-0000-000000000041', 'worker-2'),
  null,
  'a running session is not re-claimable'
);

-- A terminal session rejects appends even under the matching epoch (a resumed
-- stale driver cannot mutate the transcript after reconciliation).
update public.agent_sessions set status = 'failed', ended_reason = 'stalled'
 where id = 'a0000000-0000-0000-0000-000000000041';

select throws_ok(
  $$ select public.append_session_event('a0000000-0000-0000-0000-000000000041', 1,
       'assistant_message', '{"text": "late"}'::jsonb) $$,
  'stale claim epoch for session a0000000-0000-0000-0000-000000000041',
  'a terminal session rejects further event appends'
);

-- Restore to running so the spend tests below exercise a live row.
update public.agent_sessions set status = 'running', ended_reason = null
 where id = 'a0000000-0000-0000-0000-000000000041';

-- Spend: pricing a session moves the org counter; the null-cost start added nothing.
create function pg_temp.org_a_spend() returns numeric language sql as $$
  select spend_usd from public.organizations
  where id = 'a0000000-0000-0000-0000-000000000001';
$$;

select is(pg_temp.org_a_spend(), 0::numeric, 'an unpriced session adds nothing to spend');

update public.agent_sessions set cost_usd = 1.5
 where id = 'a0000000-0000-0000-0000-000000000041';

select is(pg_temp.org_a_spend(), 1.5::numeric, 'pricing a session moves the org spend counter');

-- recompute_org_spend includes the sessions leg.
update public.organizations set spend_usd = 0
 where id = 'a0000000-0000-0000-0000-000000000001';
select is(
  public.recompute_org_spend('a0000000-0000-0000-0000-000000000001'),
  1.5::numeric,
  'recompute_org_spend includes live-session cost'
);

-- admit_agent_session: atomic, cap-checked admission. Org A currently has one
-- active session (…41, running), so the caps below are exercised against that.
-- Per-agent: agent …31 already has an active session.
select throws_ok(
  $$ select public.admit_agent_session(
       'a0000000-0000-0000-0000-000000000031'::uuid,
       'a0000000-0000-0000-0000-000000000001'::uuid, null, 0, 'bedrock', 'glm-5',
       false, 600, 7200, 5, 5) $$,
  'agent_active',
  'admit rejects a second active session for the same agent'
);

-- Per-org: a fresh agent in org A trips the org cap of 1.
select throws_ok(
  $$ select public.admit_agent_session(
       'a0000000-0000-0000-0000-000000000033'::uuid,
       'a0000000-0000-0000-0000-000000000001'::uuid, null, 0, 'bedrock', 'glm-5',
       false, 600, 7200, 1, 5) $$,
  'org_full',
  'admit rejects a create that would breach the per-org cap'
);

-- Global: a fresh agent trips the global cap of 1.
select throws_ok(
  $$ select public.admit_agent_session(
       'a0000000-0000-0000-0000-000000000033'::uuid,
       'a0000000-0000-0000-0000-000000000001'::uuid, null, 0, 'bedrock', 'glm-5',
       false, 600, 7200, 5, 1) $$,
  'global_full',
  'admit rejects a create that would breach the global cap'
);

-- Under-cap: a fresh agent is admitted and a `starting` row returned. Removed
-- immediately so the RLS count below still sees exactly org A's one session.
select is(
  (select status from public.admit_agent_session(
     'a0000000-0000-0000-0000-000000000033'::uuid,
     'a0000000-0000-0000-0000-000000000001'::uuid, null, 0, 'bedrock', 'glm-5',
     false, 600, 7200, 5, 5))::text,
  'starting',
  'admit inserts and returns a starting session when under the caps'
);
delete from public.agent_sessions
 where agent_id = 'a0000000-0000-0000-0000-000000000033';

-- A session in org B, for the RLS cross-org check.
insert into public.agent_sessions (
  id, agent_id, org_id, harness_version, agent_provider, agent_model
)
values (
  'a0000000-0000-0000-0000-000000000042', 'a0000000-0000-0000-0000-000000000032',
  'a0000000-0000-0000-0000-000000000002', 0, 'bedrock', 'glm-5'
);

-- RLS: a member of org A sees only their org's sessions + events.
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000091', true);
set local role authenticated;

select is(
  (select count(*)::int from public.agent_sessions),
  1,
  'a member sees exactly their org''s sessions'
);

select is(
  (select count(*)::int from public.agent_session_events),
  2,
  'a member sees only events of their org''s sessions'
);

select * from finish();
rollback;
