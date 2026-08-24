begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

-- ---------------------------------------------------------------------------
-- E2 SSO substrate over the CONVERGED public.org_domains (created by
-- 20260822180000, extended by 20260901140000): the global one-claim-per-
-- domain unique, the sso_required-only-when-verified check, the admin-scoped
-- RLS read posture, and the two metadata-only definer reads for the web gate
-- and the switcher tag. Ids prefixed '82...' so ambient seed data cannot
-- perturb.

insert into public.organizations (id, slug, name) values
  ('82000000-0000-0000-0000-000000000001', 'ssod-org-a', 'SSO Domains Org A'),
  ('82000000-0000-0000-0000-000000000002', 'ssod-org-b', 'SSO Domains Org B');

-- ---------------------------------------------------------------------------
-- 1. Shape checks: lowercase-only domains, token length floor.

select throws_ok(
  $$insert into public.org_domains (org_id, domain, verification_token)
    values ('82000000-0000-0000-0000-000000000001', 'Example.com',
            'tok-82-aaaaaaaaaaaaaaaaaaaa')$$,
  '23514',
  null,
  'a mixed-case domain is refused (rows are stored lowercased)'
);

select throws_ok(
  $$insert into public.org_domains (org_id, domain, verification_token)
    values ('82000000-0000-0000-0000-000000000001', 'example.com', 'short')$$,
  '23514',
  null,
  'a token below the length floor is refused'
);

select lives_ok(
  $$insert into public.org_domains (org_id, domain, verification_token)
    values ('82000000-0000-0000-0000-000000000001', 'example.com',
            'tok-82-aaaaaaaaaaaaaaaaaaaa')$$,
  'a lowercased domain with a real token inserts'
);

-- ---------------------------------------------------------------------------
-- 2. One claim per domain, deployment-wide (the pre-existing global unique
--    from 20260822180000): a second org cannot even CLAIM a taken domain.

select throws_ok(
  $$insert into public.org_domains (org_id, domain, verification_token)
    values ('82000000-0000-0000-0000-000000000002', 'example.com',
            'tok-82-bbbbbbbbbbbbbbbbbbbb')$$,
  '23505',
  null,
  'a second org cannot claim an already-claimed domain (global unique)'
);

-- ---------------------------------------------------------------------------
-- 3. sso_required binds to verification.

select throws_ok(
  $$update public.org_domains
       set sso_required = true
     where org_id = '82000000-0000-0000-0000-000000000001'
       and domain = 'example.com'$$,
  '23514',
  null,
  'sso_required cannot be set on an unverified domain'
);

update public.org_domains
   set verified_at = now()
 where org_id = '82000000-0000-0000-0000-000000000001'
   and domain = 'example.com';

select lives_ok(
  $$update public.org_domains
       set sso_required = true
     where org_id = '82000000-0000-0000-0000-000000000001'
       and domain = 'example.com'$$,
  'sso_required sets on a verified domain'
);

-- ---------------------------------------------------------------------------
-- 4. The metadata-only definer reads answer the flag, nothing else.

select is(
  public.org_sso_required('82000000-0000-0000-0000-000000000001'),
  true,
  'org_sso_required is true once a verified domain carries the flag'
);

select is(
  public.org_sso_required('82000000-0000-0000-0000-000000000002'),
  false,
  'an org with no verified flagged domain never requires SSO'
);

select results_eq(
  $$select public.sso_required_org_ids(array[
      '82000000-0000-0000-0000-000000000001',
      '82000000-0000-0000-0000-000000000002']::uuid[])$$,
  $$values ('82000000-0000-0000-0000-000000000001'::uuid)$$,
  'sso_required_org_ids returns exactly the flagged orgs from the supplied set'
);

-- ---------------------------------------------------------------------------
-- 5. Browser roles: the pre-existing admin-scoped RLS SELECT stays (an org
--    admin reads their own rows, challenge token included — they publish
--    it); a claimless authenticated session sees NOTHING, and writes stay
--    service-role-only. The definer reads still answer.

set local role authenticated;

select is(
  (select count(*) from public.org_domains),
  0::bigint,
  'a claimless authenticated session sees no org_domains rows (RLS)'
);

select throws_ok(
  $$insert into public.org_domains (org_id, domain, verification_token)
    values ('82000000-0000-0000-0000-000000000001', 'rogue.example',
            'tok-82-cccccccccccccccccccc')$$,
  '42501',
  null,
  'authenticated cannot insert org_domains'
);

select throws_ok(
  $$update public.org_domains set sso_required = false$$,
  '42501',
  null,
  'authenticated cannot update org_domains'
);

select is(
  public.org_sso_required('82000000-0000-0000-0000-000000000001'),
  true,
  'authenticated may still read the org-level flag through the definer'
);

reset role;

-- ---------------------------------------------------------------------------
-- 6. service_role holds the DML the control API writes with.

select ok(
  has_table_privilege('service_role', 'public.org_domains', 'insert')
  and has_table_privilege('service_role', 'public.org_domains', 'update')
  and has_table_privilege('service_role', 'public.org_domains', 'delete'),
  'the control API writes org_domains as service_role'
);

select * from finish();

rollback;
