begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

update public.app_settings set signups_enabled = true;

-- Four orgs: A applies the default launch grant, B an explicit amount+expiry,
-- C exercises the expiry clawback, D is the never-YC control.
insert into public.organizations (id, slug, name)
values
  ('52000000-0000-0000-0000-0000000000a1', 'pgtap-yc-a', 'pgTAP YC A'),
  ('52000000-0000-0000-0000-0000000000b1', 'pgtap-yc-b', 'pgTAP YC B'),
  ('52000000-0000-0000-0000-0000000000c1', 'pgtap-yc-c', 'pgTAP YC C'),
  ('52000000-0000-0000-0000-0000000000d1', 'pgtap-yc-d', 'pgTAP YC D');

insert into auth.users (id, email)
values
  ('52000000-0000-0000-0000-0000000000e1', 'yc.founder.a@example.com');

-- ---------------------------------------------------------------------------
-- The launch grant: apply the `yc` label + a $526 grant, folding the $20
-- welcome promo (total launch credit is $526, not $546), one transaction.

create temp table yc_a as
select * from public.apply_yc_launch_grant(
  '52000000-0000-0000-0000-0000000000a1',
  526,
  null,
  '52000000-0000-0000-0000-0000000000e1'
);

select is((select granted_usd from yc_a), 526::numeric, 'the launch grant is $526');
select is(
  (select balance_usd from yc_a), 526::numeric,
  'the post-grant balance is $526: the welcome promo is folded in, not stacked'
);
select ok((select newly_applied from yc_a), 'the first apply reports newly_applied');
select is(
  (select credit_granted_usd from public.organizations
    where id = '52000000-0000-0000-0000-0000000000a1'),
  526.000000::numeric,
  'the trigger-maintained counter lands at $526 (20 promo + 526 grant - 20 reversal)'
);
select ok(
  exists (
    select 1 from public.org_labels
     where org_id = '52000000-0000-0000-0000-0000000000a1' and key = 'yc'
  ),
  'the org is marked a YC company via the `yc` label'
);
select ok(
  exists (
    select 1 from public.credit_ledger
     where source_ref = 'yc-launch:52000000-0000-0000-0000-0000000000a1'
       and entry_type = 'grant'
       and expires_at is not null
       and billable_spend_at_grant_usd is not null
  ),
  'the launch grant carries its expiry and spend snapshot'
);
select is(
  (select count(*) from public.credit_ledger
    where org_id = '52000000-0000-0000-0000-0000000000a1' and source = 'yc_launch'),
  2::bigint,
  'the launch writes exactly two yc_launch rows (the grant and the promo reversal)'
);

-- Idempotent replay: no second grant, no second label, newly_applied false.
create temp table yc_a2 as
select * from public.apply_yc_launch_grant(
  '52000000-0000-0000-0000-0000000000a1', 526, null,
  '52000000-0000-0000-0000-0000000000e1'
);
select ok((select not newly_applied from yc_a2), 'a replay reports newly_applied false');
select is(
  (select count(*) from public.credit_ledger
    where org_id = '52000000-0000-0000-0000-0000000000a1' and source = 'yc_launch'),
  2::bigint,
  'a replay writes no additional yc_launch rows'
);
select is(
  (select count(*) from public.org_labels
    where org_id = '52000000-0000-0000-0000-0000000000a1' and key = 'yc'),
  1::bigint,
  'a replay leaves exactly one yc label'
);

-- ---------------------------------------------------------------------------
-- Explicit amount + expiry (the admin lane).

create temp table yc_b as
select * from public.apply_yc_launch_grant(
  '52000000-0000-0000-0000-0000000000b1',
  1000,
  '2027-01-01T00:00:00+00:00',
  null
);
select is((select granted_usd from yc_b), 1000::numeric, 'the admin grant honors the amount');
select is(
  (select expires_at from yc_b), '2027-01-01T00:00:00+00:00'::timestamptz,
  'the admin grant honors the expiry'
);

-- ---------------------------------------------------------------------------
-- Expiry clawback: the unspent part is reclaimed, capped so the balance never
-- goes negative, and the pass is idempotent.

create temp table yc_c as
select * from public.apply_yc_launch_grant(
  '52000000-0000-0000-0000-0000000000c1', 526,
  now() - interval '1 second', null
);
select is(
  public.process_expiring_grants(), 1,
  'one expired grant is processed'
);
select is(
  (select credit_granted_usd - billable_spend_usd from public.organizations
    where id = '52000000-0000-0000-0000-0000000000c1'),
  0::numeric,
  'the clawback reclaims the unspent grant, leaving a zero balance (never negative)'
);
select is(
  public.process_expiring_grants(), 0,
  'a second pass is a no-op (idempotent)'
);

-- ---------------------------------------------------------------------------
-- The never-YC control: org D has no label.

select ok(
  not exists (
    select 1 from public.org_labels
     where org_id = '52000000-0000-0000-0000-0000000000d1' and key = 'yc'
  ),
  'an org that never applied the grant is not a YC company'
);

-- Regression: the member-facing YC read (orgIsYcCompany, the /credits page)
-- runs as the `authenticated` role, which needs the TABLE select grant — an RLS
-- policy alone is not enough. Without it every signed-in read 500s with
-- "permission denied for table org_labels" (the #770 hotfix,
-- 20260901010000). The policy still scopes the rows to key = 'yc' + own org.
select ok(
  has_table_privilege('authenticated', 'public.org_labels', 'SELECT'),
  'the authenticated role has SELECT on org_labels (member-facing YC read)'
);

select finish();
rollback;
