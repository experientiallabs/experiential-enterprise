-- Org special-attribute labels + internal admin notes (migration
-- 20260831000000) and promotion audience targeting keyed on those labels.
--
-- Labels: add_org_label is idempotent on (org_id, key), the unique constraint
-- and key-slug check hold, remove is idempotent, and both writers are
-- service-role only. Notes: add is author-attributed and body-trimmed, the
-- length check refuses a blank body, delete returns the removed row (and
-- nothing on a miss), and both writers are service-role only. Audience: a
-- promotion with a non-empty audience_labels set is offered by
-- gateway_promo_state only to an org carrying every required label; an empty
-- audience applies to every account.

begin;

create extension if not exists pgtap with schema extensions;

select plan(21);

insert into public.organizations (id, slug, name) values
  ('77000000-0000-0000-0000-000000000001', 'pgtap-labels-a', 'Labels A'),
  ('77000000-0000-0000-0000-000000000002', 'pgtap-labels-b', 'Labels B');

-- ---------------------------------------------------------------------------
-- Labels.

select is(
  (select key from public.add_org_label(
     '77000000-0000-0000-0000-000000000001', 'yc',
     '77000000-0000-0000-0000-0000000000f0')),
  'yc', 'add_org_label returns the created row');

-- A replay of the same (org, key) does not duplicate.
select public.add_org_label(
  '77000000-0000-0000-0000-000000000001', 'yc',
  '77000000-0000-0000-0000-0000000000f1');
select is(
  (select pg_catalog.count(*) from public.org_labels
    where org_id = '77000000-0000-0000-0000-000000000001' and key = 'yc'),
  1::pg_catalog.int8, 'add_org_label is idempotent on (org_id, key)');

select throws_ok(
  $$insert into public.org_labels (org_id, key, created_by)
    values ('77000000-0000-0000-0000-000000000001', 'yc',
            '77000000-0000-0000-0000-0000000000f2')$$,
  '23505', null, 'the (org_id, key) unique constraint refuses a duplicate label');

select public.remove_org_label('77000000-0000-0000-0000-000000000001', 'yc');
select is(
  (select pg_catalog.count(*) from public.org_labels
    where org_id = '77000000-0000-0000-0000-000000000001' and key = 'yc'),
  0::pg_catalog.int8, 'remove_org_label removes the label');

select lives_ok(
  $$select public.remove_org_label('77000000-0000-0000-0000-000000000001', 'yc')$$,
  'remove_org_label is idempotent (removing an absent label is a no-op)');

select throws_ok(
  $$insert into public.org_labels (org_id, key, created_by)
    values ('77000000-0000-0000-0000-000000000001', 'Bad Key',
            '77000000-0000-0000-0000-0000000000f3')$$,
  '23514', null, 'the key check refuses a slug outside ^[a-z][a-z0-9-]{0,31}$');

select ok(
  not has_function_privilege(
    'authenticated', 'public.add_org_label(uuid, text, uuid)', 'execute')
  and not has_function_privilege(
    'anon', 'public.add_org_label(uuid, text, uuid)', 'execute')
  and has_function_privilege(
    'service_role', 'public.add_org_label(uuid, text, uuid)', 'execute'),
  'add_org_label is service-role only');

select ok(
  not has_function_privilege(
    'authenticated', 'public.remove_org_label(uuid, text)', 'execute')
  and has_function_privilege(
    'service_role', 'public.remove_org_label(uuid, text)', 'execute'),
  'remove_org_label is service-role only');

-- Runtime refusal: a non-service_role caller cannot execute the definer write.
set local role authenticated;
select throws_ok(
  $$select public.add_org_label('77000000-0000-0000-0000-000000000001', 'yc',
      '77000000-0000-0000-0000-0000000000f4')$$,
  '42501', null, 'a non-service_role caller cannot execute add_org_label');
reset role;

-- ---------------------------------------------------------------------------
-- Notes.

create temp table note1 as
select * from public.add_org_admin_note(
  '77000000-0000-0000-0000-000000000001',
  '77000000-0000-0000-0000-0000000000f0', 'admin@pgtap.example', '  hello  ');

select is((select body from note1), 'hello', 'add_org_admin_note trims the body');
select is(
  (select author_email from note1), 'admin@pgtap.example',
  'add_org_admin_note attributes the note to its author');

select throws_ok(
  $$select public.add_org_admin_note(
      '77000000-0000-0000-0000-000000000001',
      '77000000-0000-0000-0000-0000000000f0', 'admin@pgtap.example', '   ')$$,
  '23514', null, 'a blank note body violates the length check');

-- Delete is scoped to (org, note): a mismatched org is a no-op that deletes
-- nothing, so a note cannot be removed through another org's URL.
select is_empty(
  $$select * from public.delete_org_admin_note(
      '77000000-0000-0000-0000-000000000002', (select id from note1))$$,
  'delete_org_admin_note does not delete through a mismatched org');
select is(
  (select pg_catalog.count(*) from public.org_admin_notes
    where id = (select id from note1)),
  1::pg_catalog.int8, 'the mismatched-org delete left the note in place');
select isnt_empty(
  $$select * from public.delete_org_admin_note(
      '77000000-0000-0000-0000-000000000001', (select id from note1))$$,
  'delete_org_admin_note returns the removed note for the owning org');
select is_empty(
  $$select * from public.delete_org_admin_note(
      '77000000-0000-0000-0000-000000000001', (select id from note1))$$,
  'deleting an already-removed note returns nothing');

select ok(
  not has_function_privilege(
    'authenticated', 'public.add_org_admin_note(uuid, uuid, text, text)', 'execute')
  and has_function_privilege(
    'service_role', 'public.add_org_admin_note(uuid, uuid, text, text)', 'execute'),
  'add_org_admin_note is service-role only');

select ok(
  not has_function_privilege(
    'authenticated', 'public.delete_org_admin_note(uuid, uuid)', 'execute')
  and has_function_privilege(
    'service_role', 'public.delete_org_admin_note(uuid, uuid)', 'execute'),
  'delete_org_admin_note is service-role only');

-- ---------------------------------------------------------------------------
-- Audience targeting through gateway_promo_state.

insert into public.models (slug, display_name) values
  ('lbl-promo-model', 'Label Promo Model');

insert into public.model_promotions
  (id, label, per_org_cap_micro_usd, discount_cap_micro_usd, cap_scope,
   percent_off, providers, audience_labels, active, display_order)
values
  ('77000000-0000-0000-0000-0000000000d1', 'yc-only-promo', 0, 0, 'lifetime',
   50, '{}', array['yc'], true, 0);

insert into public.model_promotion_models (promotion_id, model_id, slug)
select '77000000-0000-0000-0000-0000000000d1', models.id, models.slug
  from public.models
 where models.slug = 'lbl-promo-model' and models.owning_org_id is null;

-- Org A carries the yc label; org B does not.
select public.add_org_label(
  '77000000-0000-0000-0000-000000000001', 'yc',
  '77000000-0000-0000-0000-0000000000f0');

select is(
  (select is_promo from public.gateway_promo_state(
     '77000000-0000-0000-0000-000000000001', 'lbl-promo-model', 'prov', 2000000)),
  true, 'an audience-scoped promotion is offered to an org carrying the label');

select is(
  (select is_promo from public.gateway_promo_state(
     '77000000-0000-0000-0000-000000000002', 'lbl-promo-model', 'prov', 2000000)),
  false, 'an audience-scoped promotion is NOT offered to an unlabeled org');

-- Emptying the audience makes it apply to every account again.
update public.model_promotions set audience_labels = '{}'
 where id = '77000000-0000-0000-0000-0000000000d1';
select is(
  (select is_promo from public.gateway_promo_state(
     '77000000-0000-0000-0000-000000000002', 'lbl-promo-model', 'prov', 2000000)),
  true, 'an empty audience applies the promotion to every account');

select * from finish();

rollback;
