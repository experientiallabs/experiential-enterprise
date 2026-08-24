begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

-- Two orgs and two users. Inserting into auth.users fires the provisioning
-- trigger (personal orgs), which is orthogonal to the domain-join tables here.
insert into public.organizations (id, slug, name)
values
  ('60000000-0000-0000-0000-00000000aaaa', 'org-a', 'Org A'),
  ('60000000-0000-0000-0000-00000000bbbb', 'org-b', 'Org B');

insert into auth.users (id, email, email_confirmed_at)
values
  ('60000000-0000-0000-0000-000000000001', 'dev@acme.test', now()),
  ('60000000-0000-0000-0000-000000000002', 'ops@acme.test', null);

-- org_domains CHECK: only bare, lowercase, dotted domains are storable.
select throws_ok(
  $$
  insert into public.org_domains (org_id, domain)
  values ('60000000-0000-0000-0000-00000000aaaa', 'Acme.test')
  $$,
  '23514',
  null,
  'a domain with uppercase is rejected'
);

select throws_ok(
  $$
  insert into public.org_domains (org_id, domain)
  values ('60000000-0000-0000-0000-00000000aaaa', 'a@acme.test')
  $$,
  '23514',
  null,
  'a domain containing @ is rejected'
);

select throws_ok(
  $$
  insert into public.org_domains (org_id, domain)
  values ('60000000-0000-0000-0000-00000000aaaa', 'nodot')
  $$,
  '23514',
  null,
  'a domain with no dot is rejected'
);

select lives_ok(
  $$
  insert into public.org_domains (org_id, domain)
  values ('60000000-0000-0000-0000-00000000aaaa', 'acme.test')
  $$,
  'a bare lowercase domain is accepted'
);

-- One org per domain: a second org cannot claim the same domain.
select throws_ok(
  $$
  insert into public.org_domains (org_id, domain)
  values ('60000000-0000-0000-0000-00000000bbbb', 'acme.test')
  $$,
  '23505',
  null,
  'a domain already associated with an org is rejected'
);

-- auth_user_verification exposes email + inbox_proven (the decoupled inbox-proof
-- signal, NOT the raw email_confirmed_at login flag). Running as superuser the
-- definer's guard needs a role claim; assert service_role.
select set_config('request.jwt.claim.role', 'service_role', true);

-- Both users are auto-confirmed for login; inbox proof is expressed by whether
-- their founding (auto-provisioned personal) org has spend unlocked. Unlock a1's
-- so it reads proven; a2's stays locked so it reads unproven.
update public.organizations set spend_unlocked_at = now()
 where id in (
   select org_id from public.organization_members
    where user_id = '60000000-0000-0000-0000-000000000001' and role = 'admin'
 );

select is(
  (select email from public.auth_user_verification('60000000-0000-0000-0000-000000000001')),
  'dev@acme.test',
  'auth_user_verification returns the user email'
);

select is(
  (
    select inbox_proven
    from public.auth_user_verification('60000000-0000-0000-0000-000000000001')
  ),
  true,
  'a user whose founding org has spend unlocked reads back as inbox-proven'
);

select is(
  (
    select inbox_proven
    from public.auth_user_verification('60000000-0000-0000-0000-000000000002')
  ),
  false,
  'an auto-confirmed user whose founding org is still spend-locked reads back as unproven'
);

-- Join requests: the status CHECK and the pending partial-unique index.
select throws_ok(
  $$
  insert into public.org_join_requests (org_id, user_id, email, status)
  values (
    '60000000-0000-0000-0000-00000000aaaa',
    '60000000-0000-0000-0000-000000000002',
    'ops@acme.test',
    'bogus'
  )
  $$,
  '23514',
  null,
  'an unknown request status is rejected'
);

insert into public.org_join_requests (org_id, user_id, email)
values (
  '60000000-0000-0000-0000-00000000aaaa',
  '60000000-0000-0000-0000-000000000002',
  'ops@acme.test'
);

select throws_ok(
  $$
  insert into public.org_join_requests (org_id, user_id, email)
  values (
    '60000000-0000-0000-0000-00000000aaaa',
    '60000000-0000-0000-0000-000000000002',
    'ops@acme.test'
  )
  $$,
  '23505',
  null,
  'a second pending request for the same org and user is rejected'
);

-- A decided request frees the pending slot: a new request may open.
update public.org_join_requests
set status = 'approved', decided_at = now()
where org_id = '60000000-0000-0000-0000-00000000aaaa'
  and user_id = '60000000-0000-0000-0000-000000000002';

select lives_ok(
  $$
  insert into public.org_join_requests (org_id, user_id, email)
  values (
    '60000000-0000-0000-0000-00000000aaaa',
    '60000000-0000-0000-0000-000000000002',
    'ops@acme.test'
  )
  $$,
  'a new pending request is allowed once the previous one was decided'
);

-- approve_org_join_request settles the request AND grants membership in one
-- transaction. U1 has no membership in Org A yet.
insert into public.org_join_requests (id, org_id, user_id, email)
values (
  '60000000-0000-0000-0000-00000000dddd',
  '60000000-0000-0000-0000-00000000aaaa',
  '60000000-0000-0000-0000-000000000001',
  'dev@acme.test'
);

select is(
  (
    select status
    from public.approve_org_join_request(
      '60000000-0000-0000-0000-00000000dddd',
      '60000000-0000-0000-0000-000000000001'
    )
  ),
  'approved',
  'approve_org_join_request settles the request to approved'
);

select isnt_empty(
  $$
  select 1
  from public.organization_members
  where org_id = '60000000-0000-0000-0000-00000000aaaa'
    and user_id = '60000000-0000-0000-0000-000000000001'
  $$,
  'approval grants org membership'
);

-- A repeat approval is a no-op: the request is already decided, so no second
-- membership row appears.
select public.approve_org_join_request(
  '60000000-0000-0000-0000-00000000dddd',
  '60000000-0000-0000-0000-000000000001'
);

select is(
  (
    select count(*)::int
    from public.organization_members
    where org_id = '60000000-0000-0000-0000-00000000aaaa'
      and user_id = '60000000-0000-0000-0000-000000000001'
  ),
  1,
  'a repeat approval does not duplicate the membership'
);

select * from finish();

rollback;
