begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

select has_trigger(
  'auth',
  'users',
  'cleanup_deleted_auth_user',
  'auth user deletion has a public-data cleanup trigger'
);

-- User deletion: GoTrue/auth is the root delete and the trigger cleans every
-- public per-user reference while preserving organization-owned resources.
select set_config('explabs.seed_admin_email', 'delete-me@example.com', true);
insert into auth.users (id, email)
values ('a1000000-0000-0000-0000-000000000001', 'delete-me@example.com');

insert into public.organizations (id, slug, name)
values ('a1000000-0000-0000-0000-000000000010', 'retained-org', 'Retained Org');

insert into public.organization_members (org_id, user_id, role)
values (
  'a1000000-0000-0000-0000-000000000010',
  'a1000000-0000-0000-0000-000000000001',
  'user'
);

insert into public.platform_admins (user_id)
values ('a1000000-0000-0000-0000-000000000001');

insert into public.platform_admins (user_id, granted_by)
values (
  'a1000000-0000-0000-0000-000000000002',
  'a1000000-0000-0000-0000-000000000001'
);

insert into public.org_invitations (org_id, email, invited_by)
values (
  'a1000000-0000-0000-0000-000000000010',
  'someone-else@example.com',
  'a1000000-0000-0000-0000-000000000001'
);

insert into public.org_invitations (org_id, email, accepted_at, accepted_by)
values (
  'a1000000-0000-0000-0000-000000000010',
  'delete-me@example.com',
  now(),
  'a1000000-0000-0000-0000-000000000001'
);

insert into public.wm_catalog_entries (
  id, name, serve_provider, serve_model, storage_path, byte_size, sha256
)
values (
  'a1000000-0000-0000-0000-000000000020',
  'admin-delete-test',
  'azure',
  'gpt-5.5',
  'catalog/admin-delete-test/bundle.tar.gz',
  1,
  repeat('a', 64)
);

insert into public.wm_catalog_entry_likes (entry_id, user_id)
values (
  'a1000000-0000-0000-0000-000000000020',
  'a1000000-0000-0000-0000-000000000001'
);

insert into public.user_onboarding (user_id)
values ('a1000000-0000-0000-0000-000000000001');

insert into public.api_keys (org_id, name, key_prefix, key_hash, created_by)
values (
  'a1000000-0000-0000-0000-000000000010',
  'retained key',
  'xpl_admin_delete',
  repeat('b', 64),
  'a1000000-0000-0000-0000-000000000001'
);

insert into public.harnesses (id, org_id, name, created_by)
values (
  'a1000000-0000-0000-0000-000000000030',
  'a1000000-0000-0000-0000-000000000010',
  'retained-harness',
  'a1000000-0000-0000-0000-000000000001'
);

insert into public.harness_versions (harness_id, version, doc, doc_hash, created_by)
values (
  'a1000000-0000-0000-0000-000000000030',
  1,
  '{}',
  repeat('c', 32),
  'a1000000-0000-0000-0000-000000000001'
);

insert into public.world_models (id, org_id, name, status)
values (
  'a1000000-0000-0000-0000-000000000040',
  'a1000000-0000-0000-0000-000000000010',
  'retained-session-model',
  'ready'
);

insert into public.agents (id, org_id, world_model_id, name, agent_provider, agent_model)
values (
  'a1000000-0000-0000-0000-000000000041',
  'a1000000-0000-0000-0000-000000000010',
  'a1000000-0000-0000-0000-000000000040',
  'retained-session-agent',
  'bedrock',
  'glm-5'
);

insert into public.agent_sessions (
  id, agent_id, created_by, harness_version, agent_provider, agent_model
)
values (
  'a1000000-0000-0000-0000-000000000042',
  'a1000000-0000-0000-0000-000000000041',
  'a1000000-0000-0000-0000-000000000001',
  0,
  'bedrock',
  'glm-5'
);

insert into public.agent_session_commands (session_id, actor_id, kind)
values (
  'a1000000-0000-0000-0000-000000000042',
  'a1000000-0000-0000-0000-000000000001',
  'user_message'
);

delete from auth.users where id = 'a1000000-0000-0000-0000-000000000001';

select is((select count(*)::int from auth.users where id = 'a1000000-0000-0000-0000-000000000001'), 0, 'auth user is deleted');
select is((select count(*)::int from public.organization_members where user_id = 'a1000000-0000-0000-0000-000000000001'), 0, 'memberships are deleted');
select is((select count(*)::int from public.platform_admins where user_id = 'a1000000-0000-0000-0000-000000000001'), 0, 'platform-admin grant is deleted');
select is((select count(*)::int from public.platform_admins where user_id = 'a1000000-0000-0000-0000-000000000002' and granted_by is null), 1, 'other platform-admin grants clear deleted-user provenance');
select is((select count(*)::int from public.org_invitations where email = 'delete-me@example.com'), 0, 'deleted account invite history is removed');
select is((select count(*)::int from public.org_invitations where email = 'someone-else@example.com' and invited_by is null), 1, 'other invites keep no stale inviter id');
select is((select count(*)::int from public.wm_catalog_entry_likes where user_id = 'a1000000-0000-0000-0000-000000000001'), 0, 'catalog likes are deleted');
select is((select count(*)::int from public.user_onboarding where user_id = 'a1000000-0000-0000-0000-000000000001'), 0, 'onboarding state is deleted');
select is((select count(*)::int from public.api_keys where name = 'retained key'), 1, 'organization API keys are preserved');
select is((select count(*)::int from public.api_keys where name = 'retained key' and created_by is null), 1, 'API key creator pointer is cleared');
select is((select count(*)::int from public.harnesses where name = 'retained-harness' and created_by is null), 1, 'harness is preserved without a stale creator');
select is((select count(*)::int from public.harness_versions where harness_id = 'a1000000-0000-0000-0000-000000000030' and created_by is null), 1, 'harness version creator pointer is cleared');
select is((select count(*)::int from public.agent_sessions where id = 'a1000000-0000-0000-0000-000000000042' and created_by is null), 1, 'organization-owned agent session is preserved without a stale creator');
select is((select count(*)::int from public.agent_session_commands where actor_id = 'a1000000-0000-0000-0000-000000000001'), 0, 'deleted-user session commands are removed');

-- Organization deletion: remove the tenant graph, delete auth users orphaned
-- by it, and preserve users with another org plus platform operators.
select set_config('explabs.seed_admin_email', 'orphan@example.com', true);
insert into auth.users (id, email)
values ('a2000000-0000-0000-0000-000000000001', 'orphan@example.com');
select set_config('explabs.seed_admin_email', 'shared@example.com', true);
insert into auth.users (id, email)
values ('a2000000-0000-0000-0000-000000000002', 'shared@example.com');
select set_config('explabs.seed_admin_email', 'operator@example.com', true);
insert into auth.users (id, email)
values ('a2000000-0000-0000-0000-000000000003', 'operator@example.com');

insert into public.organizations (id, slug, name)
values
  ('a2000000-0000-0000-0000-000000000010', 'doomed-org', 'Doomed Org'),
  ('a2000000-0000-0000-0000-000000000011', 'shared-org', 'Shared Org');

insert into public.organization_members (org_id, user_id, role)
values
  ('a2000000-0000-0000-0000-000000000010', 'a2000000-0000-0000-0000-000000000001', 'user'),
  ('a2000000-0000-0000-0000-000000000010', 'a2000000-0000-0000-0000-000000000002', 'user'),
  ('a2000000-0000-0000-0000-000000000010', 'a2000000-0000-0000-0000-000000000003', 'user'),
  ('a2000000-0000-0000-0000-000000000011', 'a2000000-0000-0000-0000-000000000002', 'user');

insert into public.platform_admins (user_id)
values ('a2000000-0000-0000-0000-000000000003');

insert into public.user_onboarding (user_id)
values ('a2000000-0000-0000-0000-000000000001');

insert into public.api_keys (org_id, name, key_prefix, key_hash)
values (
  'a2000000-0000-0000-0000-000000000010',
  'doomed key',
  'xpl_doomed_key',
  repeat('d', 64)
);

create temporary table admin_deletion_result (
  deleted_org_id uuid,
  deleted_user_count bigint
);

-- The RPC runs under `role authenticated`, which does not own the temp
-- capture table; grant the insert it needs.
grant insert on table admin_deletion_result to authenticated;

select set_config('request.jwt.claim.sub', 'a2000000-0000-0000-0000-000000000003', true);
set local role authenticated;
insert into admin_deletion_result
select * from public.admin_delete_organization('a2000000-0000-0000-0000-000000000010');
reset role;

select is((select deleted_user_count from admin_deletion_result), 1::bigint, 'organization deletion reports one orphan auth user');
select is((select count(*)::int from public.organizations where id = 'a2000000-0000-0000-0000-000000000010'), 0, 'organization row is deleted');
select is((select count(*)::int from public.api_keys where name = 'doomed key'), 0, 'organization-owned rows cascade away');
select is((select count(*)::int from auth.users where id = 'a2000000-0000-0000-0000-000000000001'), 0, 'orphan former member is deleted from auth');
select is((select count(*)::int from public.user_onboarding where user_id = 'a2000000-0000-0000-0000-000000000001'), 0, 'orphan former member public state is deleted');
select is((select count(*)::int from auth.users where id = 'a2000000-0000-0000-0000-000000000002'), 1, 'multi-organization user remains in auth');
select is((select count(*)::int from public.organization_members where org_id = 'a2000000-0000-0000-0000-000000000011' and user_id = 'a2000000-0000-0000-0000-000000000002'), 1, 'multi-organization user keeps the other membership');
select is((select count(*)::int from auth.users where id = 'a2000000-0000-0000-0000-000000000003'), 1, 'platform operator remains in auth');
select is((select count(*)::int from public.platform_admins where user_id = 'a2000000-0000-0000-0000-000000000003'), 1, 'platform operator grant is preserved');

select * from finish();

rollback;
