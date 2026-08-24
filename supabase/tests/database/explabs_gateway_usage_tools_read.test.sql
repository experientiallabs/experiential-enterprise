-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Tool-call telemetry read (20260821120000_gateway_usage_tools_read.sql):
-- list_gateway_usage_events surfaces gateway_usage_events.tools_used verbatim,
-- names only, NULL and all. Depends on the tools_used column from the schema
-- half (20260821110000), which precedes this in the merge train.

begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

-- Fixtures: one org/key and two settled events, one with tool names, one
-- without. Events are inserted directly (reads are under test; the append-only
-- trigger only blocks update/delete).
insert into public.organizations (id, slug, name) values
  ('64000000-0000-0000-0000-000000000001', 'pgtap-gwtr', 'pgTAP GW Tools Read');
insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('64000000-0000-0000-0000-000000000011', '64000000-0000-0000-0000-000000000001',
   'gwtr', 'xpl_gwtr', encode(sha256('gwtr'::bytea), 'hex'));
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
) values
  ('gwtr-1', '64000000-0000-0000-0000-000000000001',
   '64000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
   repeat('ab', 32), now() - interval '2 seconds', now() + interval '60 seconds',
   'completed', now()),
  ('gwtr-2', '64000000-0000-0000-0000-000000000001',
   '64000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
   repeat('ab', 32), now() - interval '2 seconds', now() + interval '60 seconds',
   'completed', now());
insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane, input_tokens,
  output_tokens, cost_micro_usd, estimated_cost_micro_usd, status,
  attempt_count, day, tools_used
) values
  ('gwtr-1', '64000000-0000-0000-0000-000000000001',
   '64000000-0000-0000-0000-000000000011', 'haiku', 'anthropic', 'platform_funded',
   100, 20, 3000, 0, 'completed', 1, current_date, array['search', 'fetch']),
  ('gwtr-2', '64000000-0000-0000-0000-000000000001',
   '64000000-0000-0000-0000-000000000011', 'haiku', 'anthropic', 'platform_funded',
   50, 10, 1500, 0, 'completed', 1, current_date, null);

select is(
  (select tools_used
     from public.list_gateway_usage_events('64000000-0000-0000-0000-000000000001')
    where request_id = 'gwtr-1'),
  array['search', 'fetch'],
  'list_gateway_usage_events returns tools_used for a tool-using request');
select is(
  (select tools_used
     from public.list_gateway_usage_events('64000000-0000-0000-0000-000000000001')
    where request_id = 'gwtr-2'),
  null,
  'list_gateway_usage_events returns NULL tools_used when none captured');

select finish();

rollback;
