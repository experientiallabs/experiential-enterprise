begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

-- Two orgs (A armed via the per-org lane, B armed via the label cohort), one
-- member of A, and one outsider who belongs to neither.
insert into public.organizations (id, slug, name)
values
  ('61000000-0000-0000-0000-0000000000a1', 'pgtap-welcome-a', 'pgTAP Welcome A'),
  ('61000000-0000-0000-0000-0000000000b1', 'pgtap-welcome-b', 'pgTAP Welcome B');

insert into auth.users (id, email)
values
  ('61000000-0000-0000-0000-0000000000e1', 'welcome.member@example.com'),
  ('61000000-0000-0000-0000-0000000000e2', 'welcome.outsider@example.com');

insert into public.organization_members (org_id, user_id, role)
values ('61000000-0000-0000-0000-0000000000a1', '61000000-0000-0000-0000-0000000000e1', 'admin');

-- ---------------------------------------------------------------------------
-- The per-org write function (the admin panel's card / superadmin key).

create temp table wt_a as
select * from public.set_org_welcome_trigger(
  '61000000-0000-0000-0000-0000000000a1', true, 526, true,
  '61000000-0000-0000-0000-0000000000e1'
);
select is((select active from wt_a), true, 'the org is armed');
select is((select display_credit_usd from wt_a), 526::numeric, 'the announced amount is stored');
select is((select show_api_key from wt_a), true, 'the API-key flag is stored');

-- Deactivating keeps the last triggered_at (only activation re-arms it).
create temp table wt_a_off as
select * from public.set_org_welcome_trigger(
  '61000000-0000-0000-0000-0000000000a1', false, 526, true, null
);
select is((select active from wt_a_off), false, 'the org disarms');
select is(
  (select triggered_at from wt_a_off), (select triggered_at from wt_a),
  'deactivating leaves triggered_at unchanged'
);

-- Re-arming bumps triggered_at forward (prior viewers see it again).
create temp table wt_a_on as
select * from public.set_org_welcome_trigger(
  '61000000-0000-0000-0000-0000000000a1', true, 526, true, null
);
select ok(
  (select triggered_at from wt_a_on) >= (select triggered_at from wt_a),
  're-arming bumps triggered_at forward'
);

-- ---------------------------------------------------------------------------
-- The label cohort lane: arm every org carrying a label. A test-unique key
-- (not 'yc') keeps the cohort exactly these two orgs — a seeded or production
-- DB carries its own 'yc'-labelled orgs, so asserting against 'yc' here would
-- be non-deterministic. The function is generic over the label key.

insert into public.org_labels (org_id, key, created_by)
values
  ('61000000-0000-0000-0000-0000000000a1', 'pgtap-welcome', '61000000-0000-0000-0000-0000000000e1'),
  ('61000000-0000-0000-0000-0000000000b1', 'pgtap-welcome', '61000000-0000-0000-0000-0000000000e1');

select is(
  public.apply_welcome_trigger_by_label('pgtap-welcome', true, 526, true, null), 2,
  'the cohort lane arms both labelled orgs'
);
select is(
  (select count(*) from public.org_welcome_trigger
    where active
      and org_id in (
        '61000000-0000-0000-0000-0000000000a1',
        '61000000-0000-0000-0000-0000000000b1'
      )),
  2::bigint,
  'both test orgs are now armed'
);

-- ---------------------------------------------------------------------------
-- The atomic claim (claim_welcome_trigger_showing): exactly one caller wins a
-- given activation. Serial calls model the racing tabs — the conditional upsert
-- advances the seen marker once, so a replay of the same activation loses.
-- The function derives the user from the JWT sub; set it for member A.

select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-0000000000e1', true);
select ok(
  public.claim_welcome_trigger_showing(
    '61000000-0000-0000-0000-0000000000a1', '2027-01-01T00:00:00+00:00'
  ),
  'the first claim of an activation wins'
);
select ok(
  not public.claim_welcome_trigger_showing(
    '61000000-0000-0000-0000-0000000000a1', '2027-01-01T00:00:00+00:00'
  ),
  'a replay of the same activation loses (the marker only advances once)'
);
select ok(
  public.claim_welcome_trigger_showing(
    '61000000-0000-0000-0000-0000000000a1', '2027-02-01T00:00:00+00:00'
  ),
  'a newer activation (re-arm) is claimable again'
);
-- No verified subject → nothing to claim.
select set_config('request.jwt.claim.sub', '', true);
select ok(
  not public.claim_welcome_trigger_showing(
    '61000000-0000-0000-0000-0000000000a1', '2027-03-01T00:00:00+00:00'
  ),
  'a subject-less caller claims nothing'
);

-- ---------------------------------------------------------------------------
-- The `authenticated` role needs the TABLE grant, not just the RLS policy
-- (the org_labels regression, #775). Without it the member-facing read 500s.

select ok(
  has_table_privilege('authenticated', 'public.org_welcome_trigger', 'SELECT'),
  'authenticated has SELECT on org_welcome_trigger (member read)'
);
select ok(
  has_table_privilege('authenticated', 'public.user_welcome_trigger_seen', 'INSERT'),
  'authenticated has INSERT on user_welcome_trigger_seen (mark seen)'
);

-- A member of org A reads exactly its own trigger, and no other org's.
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-0000000000e1', true);
set local role authenticated;
select is(
  (select count(*) from public.org_welcome_trigger), 1::bigint,
  'a member reads only their own org''s trigger under RLS'
);
select is(
  (select org_id from public.org_welcome_trigger),
  '61000000-0000-0000-0000-0000000000a1'::uuid,
  'the one visible trigger is the member''s own org'
);
reset role;

select finish();
rollback;
