-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Opt-in prompt capture (20260831120000): the org flag gates the write inside
-- the transaction, reads are org-scoped, the broadcast queue drains
-- oldest-first and stamps idempotently under re-verified consent, the
-- connection config patch flips broadcast settings without a credential,
-- retention expires old rows, and the ledger's content-free posture is
-- untouched.

begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

insert into public.organizations (id, slug, name, capture_prompt_content) values
  ('70000000-0000-0000-0000-000000000001', 'pgtap-capture-on', 'Capture On', true),
  ('70000000-0000-0000-0000-000000000002', 'pgtap-capture-off', 'Capture Off', false);
insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('70000000-0000-0000-0000-000000000011', '70000000-0000-0000-0000-000000000001',
   'cap-on', 'xpl_cpo', encode(sha256('cap-on'::bytea), 'hex')),
  ('70000000-0000-0000-0000-000000000012', '70000000-0000-0000-0000-000000000002',
   'cap-off', 'xpl_cpf', encode(sha256('cap-off'::bytea), 'hex'));
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
)
values
  ('cap-req-1', '70000000-0000-0000-0000-000000000001',
   '70000000-0000-0000-0000-000000000011', 'fable', 'rev-1', 'chat_completions',
   encode(sha256('cap-1'::bytea), 'hex'), now(), now() + interval '1 hour'),
  ('cap-req-2', '70000000-0000-0000-0000-000000000002',
   '70000000-0000-0000-0000-000000000012', 'fable', 'rev-1', 'chat_completions',
   encode(sha256('cap-2'::bytea), 'hex'), now(), now() + interval '1 hour'),
  ('cap-req-3', '70000000-0000-0000-0000-000000000001',
   '70000000-0000-0000-0000-000000000011', 'opus', 'rev-1', 'chat_completions',
   encode(sha256('cap-3'::bytea), 'hex'), now(), now() + interval '1 hour');

-- Capture persists for the opted-in org.
select public.gateway_capture_prompt(
  'cap-req-1', '70000000-0000-0000-0000-000000000001', repeat('ab12', 16),
  '[{"role":"system","content":"You are the pgTAP capture agent."},{"role":"user","content":"hi"}]'::jsonb
);
select is(
  (select count(*) from public.gateway_captured_prompts where request_id = 'cap-req-1'),
  1::bigint,
  'an opted-in org''s prompt persists');

-- The flag is the correctness gate: an opted-out org persists nothing.
select public.gateway_capture_prompt(
  'cap-req-2', '70000000-0000-0000-0000-000000000002', repeat('ab12', 16),
  '[{"role":"user","content":"secret"}]'::jsonb
);
select is(
  (select count(*) from public.gateway_captured_prompts where request_id = 'cap-req-2'),
  0::bigint,
  'an opted-out org''s prompt never persists');

-- Foreign request ids never gain content, even under the right org flag.
select public.gateway_capture_prompt(
  'cap-req-2', '70000000-0000-0000-0000-000000000001', null,
  '[{"role":"user","content":"cross-org"}]'::jsonb
);
select is(
  (select count(*) from public.gateway_captured_prompts where request_id = 'cap-req-2'),
  0::bigint,
  'content never attaches to another org''s request');

-- Replayed captures are idempotent.
select public.gateway_capture_prompt(
  'cap-req-1', '70000000-0000-0000-0000-000000000001', repeat('ab12', 16),
  '[{"role":"user","content":"replacement"}]'::jsonb
);
select is(
  (select messages -> 0 ->> 'content' from public.gateway_captured_prompts
    where request_id = 'cap-req-1'),
  'You are the pgTAP capture agent.',
  'a replayed capture never replaces the original content');

-- Org-scoped read: the owner sees it, another org reads nothing.
select is(
  (select count(*) from public.gateway_captured_prompt_read(
    '70000000-0000-0000-0000-000000000001', 'cap-req-1')),
  1::bigint,
  'the owning org reads its captured prompt');
select is(
  (select count(*) from public.gateway_captured_prompt_read(
    '70000000-0000-0000-0000-000000000002', 'cap-req-1')),
  0::bigint,
  'another org reads nothing for the same request id');

-- Group snippets: latest capture's system prompt, truncated.
select public.gateway_capture_prompt(
  'cap-req-3', '70000000-0000-0000-0000-000000000001', repeat('ab12', 16),
  '[{"role":"system","content":"A newer system prompt for the same group."},{"role":"user","content":"x"}]'::jsonb
);
update public.gateway_captured_prompts
   set captured_at = captured_at + interval '1 minute'
 where request_id = 'cap-req-3';
select results_eq(
  $$select cells.snippet from public.gateway_prompt_group_snippets(
      '70000000-0000-0000-0000-000000000001') as cells$$,
  $$values ('A newer system prompt for the same group.'::text)$$,
  'the group label is the latest capture''s system prompt');

-- Broadcast queue: oldest first, alias joined, stamped idempotently.
select results_eq(
  $$select cells.request_id, cells.alias
      from public.gateway_captured_prompts_to_export(10) as cells
     where cells.org_id = '70000000-0000-0000-0000-000000000001'$$,
  $$values ('cap-req-1'::text, 'fable'::text), ('cap-req-3'::text, 'opus'::text)$$,
  'the broadcast queue serves undelivered rows oldest-first with the request alias');
select is(
  (select count(*) from public.gateway_captured_prompts_to_export(
    10, array['70000000-0000-0000-0000-000000000001']::uuid[])),
  0::bigint,
  'an excluded org''s rows leave the queue view for the rest of the tick');
select results_eq(
  $$select claimed from public.gateway_captured_prompts_mark_exported(
      array['cap-req-1', 'cap-req-3']) as claimed order by claimed$$,
  $$values ('cap-req-1'::text), ('cap-req-3'::text)$$,
  'the claim stamps both pending rows and returns exactly their ids');
select is(
  (select count(*) from public.gateway_captured_prompts_mark_exported(
      array['cap-req-1', 'cap-req-3'])),
  0::bigint,
  'a replayed claim returns nothing');
select is(
  (select count(*) from public.gateway_captured_prompts_to_export(10)
    where org_id = '70000000-0000-0000-0000-000000000001'),
  0::bigint,
  'stamped rows leave the broadcast queue');

-- Revoked consent stops the external ship: queued rows vanish from the
-- broadcast queue the moment the flag turns off.
update public.gateway_captured_prompts
   set exported_at = null
 where request_id = 'cap-req-3';
update public.organizations
   set capture_prompt_content = false
 where id = '70000000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.gateway_captured_prompts_to_export(10)
    where org_id = '70000000-0000-0000-0000-000000000001'),
  0::bigint,
  'revoked consent removes queued rows from the broadcast queue');
-- And the CLAIM itself refuses under revoked consent, closing the window
-- between a queue read and the ship: rows materialized by an in-flight tick
-- cannot be stamped (and therefore never ship) once the flag is off.
select is(
  (select count(*) from public.gateway_captured_prompts_mark_exported(
      array['cap-req-3'])),
  0::bigint,
  'the broadcast claim refuses rows once consent is revoked');
update public.organizations
   set capture_prompt_content = true
 where id = '70000000-0000-0000-0000-000000000001';

-- Broadcast config: the patch RPC flips destination settings on an existing
-- connection without a credential, and answers nothing for a missing one.
insert into public.trace_connections (org_id, kind, config, vault_secret_id)
values (
  '70000000-0000-0000-0000-000000000001', 'braintrust',
  '{"project": "pgtap"}'::jsonb, gen_random_uuid()
);
select results_eq(
  $$select patched.config
      from public.update_trace_connection_config(
        '70000000-0000-0000-0000-000000000001', 'braintrust',
        '{"broadcast": {"enabled": true, "privacy_mode": true}}'::jsonb) as patched$$,
  $$values ('{"project": "pgtap", "broadcast": {"enabled": true, "privacy_mode": true}}'::jsonb)$$,
  'the config patch merges broadcast settings and keeps existing keys');
select is(
  (select count(*) from public.update_trace_connection_config(
    '70000000-0000-0000-0000-000000000002', 'braintrust', '{}'::jsonb)),
  0::bigint,
  'patching a missing connection answers nothing');

-- Retention: rows past 30 days expire regardless of broadcast state.
update public.gateway_captured_prompts
   set captured_at = now() - interval '31 days'
 where request_id = 'cap-req-1';
select is(
  public.expire_captured_prompts(),
  1,
  'retention expires captures older than 30 days');

select finish();

rollback;
