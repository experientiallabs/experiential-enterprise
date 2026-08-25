begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

-- Inserting an auth.users row auto-provisions a personal org (provision_signup_org),
-- so a founder resolves to that org plus any they explicitly join. The resolver
-- returns ALL of them; the operator picks by role. These tests assert the
-- explicitly-joined org shows up with the right role, case-insensitively.
insert into public.organizations (id, slug, name)
values ('71000000-0000-0000-0000-0000000000b1', 'pgtap-resolve-b', 'Resolve B');

insert into auth.users (id, email)
values ('71000000-0000-0000-0000-0000000000e1', 'Founder.A@Example.com');

insert into public.organization_members (org_id, user_id, role)
values ('71000000-0000-0000-0000-0000000000b1', '71000000-0000-0000-0000-0000000000e1', 'user');

-- As the service role (how the backend calls it) resolution runs.
select set_config('request.jwt.claim.role', 'service_role', true);

select ok(
  exists (
    select 1 from public.admin_orgs_for_emails(array['founder.a@example.com'])
     where org_id = '71000000-0000-0000-0000-0000000000b1'
  ),
  'a known email resolves to the org it explicitly joined'
);
select ok(
  exists (
    select 1 from public.admin_orgs_for_emails(array['FOUNDER.A@EXAMPLE.COM'])
     where org_id = '71000000-0000-0000-0000-0000000000b1'
  ),
  'resolution is case-insensitive on the email'
);
select is(
  (select member_role from public.admin_orgs_for_emails(array['founder.a@example.com'])
    where org_id = '71000000-0000-0000-0000-0000000000b1'),
  'user',
  'the membership role rides along so the operator can prefer the owned org'
);
select is(
  (select count(*) from public.admin_orgs_for_emails(array['nobody@nowhere.com'])),
  0::bigint,
  'an unknown email resolves to no rows'
);

-- The gate: the function is granted to service_role only, so the authenticated
-- role cannot execute it at all (permission denied, SQLSTATE 42501) — reading
-- auth.users is operator-only. The route layer also enforces
-- require_platform_admin; this is defense in depth.
set local role authenticated;
select throws_ok(
  $$ select * from public.admin_orgs_for_emails(array['founder.a@example.com']) $$,
  '42501',
  'permission denied for function admin_orgs_for_emails',
  'the authenticated role cannot execute the operator-only resolver'
);
reset role;

select finish();
rollback;
