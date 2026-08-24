begin;

create extension if not exists pgtap with schema extensions;

select plan(31);

-- ---------------------------------------------------------------------------
-- E4 teams: organization_teams + organization_team_members shapes, the two
-- membership triggers (a team member must already be an org member; losing
-- org membership cascades out of that org's teams), the detach-on-delete
-- attribution columns on api_keys / gateway_identities, and the newest-era
-- privilege posture (RLS on, zero policies, service_role-only DML). All ids
-- are prefixed '78...' so ambient seed data cannot perturb the assertions.

insert into public.organizations (id, slug, name) values
  ('78000000-0000-0000-0000-000000000001', 'teams-test-org-a', 'Teams Test Org A'),
  ('78000000-0000-0000-0000-000000000002', 'teams-test-org-b', 'Teams Test Org B');

insert into public.organization_members (org_id, user_id, role) values
  ('78000000-0000-0000-0000-000000000001', '78000000-0000-0000-0000-0000000000aa', 'admin'),
  ('78000000-0000-0000-0000-000000000001', '78000000-0000-0000-0000-0000000000bb', 'user'),
  ('78000000-0000-0000-0000-000000000002', '78000000-0000-0000-0000-0000000000cc', 'admin');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('78000000-0000-0000-0000-000000000a01', '78000000-0000-0000-0000-000000000001',
   'teams test key', 'xpl_teams78', encode(sha256('teams-test-key-1'::bytea), 'hex'));

insert into public.gateway_identities (identity_id, org_id, display_name) values
  ('teams-test-identity', '78000000-0000-0000-0000-000000000001', 'Teams Test Identity');

-- ---------------------------------------------------------------------------
-- 1. Table shapes and name constraints.

select has_table('public', 'organization_teams', 'organization_teams exists');

select has_table(
  'public', 'organization_team_members', 'organization_team_members exists'
);

select lives_ok(
  $$insert into public.organization_teams (team_id, org_id, name, created_by)
    values ('78000000-0000-0000-0000-000000000101',
            '78000000-0000-0000-0000-000000000001', 'platform',
            '78000000-0000-0000-0000-0000000000aa')$$,
  'a named team is created in its org'
);

select throws_ok(
  $$insert into public.organization_teams (org_id, name)
    values ('78000000-0000-0000-0000-000000000001', 'platform')$$,
  '23505',
  null,
  'a team name is unique within one org'
);

select lives_ok(
  $$insert into public.organization_teams (team_id, org_id, name)
    values ('78000000-0000-0000-0000-000000000103',
            '78000000-0000-0000-0000-000000000002', 'platform')$$,
  'the same team name is fine in another org'
);

select throws_ok(
  $$insert into public.organization_teams (org_id, name)
    values ('78000000-0000-0000-0000-000000000001', '')$$,
  '23514',
  null,
  'an empty team name is refused'
);

select throws_ok(
  $$insert into public.organization_teams (org_id, name)
    values ('78000000-0000-0000-0000-000000000001', repeat('x', 121))$$,
  '23514',
  null,
  'a team name longer than 120 characters is refused'
);

-- ---------------------------------------------------------------------------
-- 2. Membership: org membership is a precondition, and its removal cascades.

select lives_ok(
  $$insert into public.organization_team_members (team_id, user_id, added_by)
    values ('78000000-0000-0000-0000-000000000101',
            '78000000-0000-0000-0000-0000000000aa',
            '78000000-0000-0000-0000-0000000000aa')$$,
  'an org member joins a team'
);

select throws_ok(
  $$insert into public.organization_team_members (team_id, user_id)
    values ('78000000-0000-0000-0000-000000000101',
            '78000000-0000-0000-0000-0000000000cc')$$,
  '23514',
  null,
  'a non-member of the org cannot join its teams'
);

select throws_ok(
  $$insert into public.organization_team_members (team_id, user_id)
    values ('78000000-0000-0000-0000-000000000101',
            '78000000-0000-0000-0000-0000000000aa')$$,
  '23505',
  null,
  'the same user cannot join a team twice'
);

-- The user below is seeded onto the team, then removed from the ORG: the
-- AFTER DELETE trigger must clear their seat while leaving teammates alone.
insert into public.organization_team_members (team_id, user_id) values
  ('78000000-0000-0000-0000-000000000101', '78000000-0000-0000-0000-0000000000bb');

delete from public.organization_members
 where org_id = '78000000-0000-0000-0000-000000000001'
   and user_id = '78000000-0000-0000-0000-0000000000bb';

select is(
  (select count(*)::int from public.organization_team_members
    where user_id = '78000000-0000-0000-0000-0000000000bb'),
  0,
  'removing org membership removes the user''s team memberships'
);

select is(
  (select count(*)::int from public.organization_team_members
    where team_id = '78000000-0000-0000-0000-000000000101'),
  1,
  'teammates are untouched by another member''s org removal'
);

-- ---------------------------------------------------------------------------
-- 3. Attribution columns detach (never delete) on team deletion.

select has_column('public', 'api_keys', 'team_id', 'api_keys carries team_id');

select has_column(
  'public', 'gateway_identities', 'team_id', 'gateway_identities carries team_id'
);

insert into public.organization_teams (team_id, org_id, name) values
  ('78000000-0000-0000-0000-000000000102',
   '78000000-0000-0000-0000-000000000001', 'research');

update public.api_keys
   set team_id = '78000000-0000-0000-0000-000000000102'
 where id = '78000000-0000-0000-0000-000000000a01';

update public.gateway_identities
   set team_id = '78000000-0000-0000-0000-000000000102'
 where identity_id = 'teams-test-identity';

delete from public.organization_teams
 where team_id = '78000000-0000-0000-0000-000000000102';

select is(
  (select team_id from public.api_keys
    where id = '78000000-0000-0000-0000-000000000a01'),
  null::uuid,
  'deleting a team detaches its keys instead of deleting them'
);

select is(
  (select team_id from public.gateway_identities
    where identity_id = 'teams-test-identity'),
  null::uuid,
  'deleting a team detaches its identities instead of deleting them'
);

-- ---------------------------------------------------------------------------
-- 4. Deletion cascades: team -> members, org -> teams.

delete from public.organization_teams
 where team_id = '78000000-0000-0000-0000-000000000101';

select is(
  (select count(*)::int from public.organization_team_members
    where team_id = '78000000-0000-0000-0000-000000000101'),
  0,
  'deleting a team deletes its membership rows'
);

delete from public.organizations
 where id = '78000000-0000-0000-0000-000000000002';

select is(
  (select count(*)::int from public.organization_teams
    where org_id = '78000000-0000-0000-0000-000000000002'),
  0,
  'deleting an org deletes its teams'
);

-- ---------------------------------------------------------------------------
-- 5. Privilege posture: RLS on with zero policies; browser roles get nothing;
--    the control API (service_role) holds DML.

set local role authenticated;

select throws_ok(
  $$select count(*) from public.organization_teams$$,
  '42501',
  null,
  'authenticated cannot read organization_teams'
);

select throws_ok(
  $$select count(*) from public.organization_team_members$$,
  '42501',
  null,
  'authenticated cannot read organization_team_members'
);

select throws_ok(
  $$insert into public.organization_teams (org_id, name)
    values ('78000000-0000-0000-0000-000000000001', 'rogue')$$,
  '42501',
  null,
  'authenticated cannot insert organization_teams'
);

select throws_ok(
  $$insert into public.organization_team_members (team_id, user_id)
    values ('78000000-0000-0000-0000-000000000101',
            '78000000-0000-0000-0000-0000000000aa')$$,
  '42501',
  null,
  'authenticated cannot insert organization_team_members'
);

reset role;

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('organization_teams', 'organization_team_members')),
  0,
  'the teams tables carry zero RLS policies (revoke-all posture)'
);

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.organization_teams'::regclass),
  'RLS is enabled on organization_teams'
);

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.organization_team_members'::regclass),
  'RLS is enabled on organization_team_members'
);

select ok(
  has_table_privilege('service_role', 'public.organization_teams', 'select'),
  'service role reads teams'
);

select ok(
  has_table_privilege('service_role', 'public.organization_teams', 'insert'),
  'service role creates teams'
);

select ok(
  has_table_privilege('service_role', 'public.organization_teams', 'update'),
  'service role renames teams'
);

select ok(
  has_table_privilege('service_role', 'public.organization_teams', 'delete'),
  'service role deletes teams'
);

select ok(
  has_table_privilege('service_role', 'public.organization_team_members', 'insert'),
  'service role adds team members'
);

select ok(
  has_table_privilege('service_role', 'public.organization_team_members', 'delete'),
  'service role removes team members'
);

select * from finish();

rollback;
