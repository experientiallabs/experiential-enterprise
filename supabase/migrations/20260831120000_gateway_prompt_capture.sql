-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Opt-in prompt capture: the first consumer of organizations.capture_prompt_content.
--
-- The gateway ledger is content-free by construction (gateway_requests.
-- content_retained = 0) and STAYS that way. Captured prompt content lives in
-- its own table with its own retention, written only for organizations whose
-- admins flipped the org-wide opt-in (Settings -> Observability, mirrored on
-- Insights), and only by the capture SQL function below — which re-checks the
-- flag inside the transaction, so a worker racing a just-flipped-off toggle
-- can never persist content the org no longer allows.
--
-- Lifecycle: the worker captures the request's canonical messages at accept
-- time (async, off the dispatch hot path); rows expire after
-- 30 days via the scheduled cleanup (same pg_cron pattern as
-- expire-synthetic-accounts); org deletion cascades.
--
-- This table is the store of record. Content leaves the platform only
-- through Broadcast (the OpenRouter model): an org explicitly enables a
-- destination on its stored observability connection (config.broadcast on
-- trace_connections, toggled through update_trace_connection_config), and
-- the scheduled broadcast tick delivers captured rows there at-least-once —
-- with an optional per-destination privacy mode that strips content and
-- ships metadata only. There is no content-pull API. Dashboard reads are
-- org-scoped RPCs: the request log's prompt expansion and the Insights
-- "repeated prompts" text labels. Only organizations that captured content
-- can read any; everyone else keeps the content-free experience.
--
-- Migration prefix 20260831120000 is collision-free across the assembled
-- train union.

create table public.gateway_captured_prompts (
  request_id pg_catalog.text primary key
    references public.gateway_requests(request_id) on delete cascade,
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  -- Content-free grouping key copied from the request so group labels join
  -- without touching gateway_requests.
  prompt_sha256 pg_catalog.text
    check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  -- The canonical GatewayMessage array as sent (role/content/tool linkage),
  -- bounded so a pathological prompt cannot bloat the table.
  messages pg_catalog.jsonb not null
    check (pg_catalog.pg_column_size(messages) <= 1048576),
  captured_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  -- Set when the broadcast tick delivered this row to the org's enabled
  -- destination (or stamped it as having nowhere to go); null = pending.
  exported_at pg_catalog.timestamptz
);

comment on table public.gateway_captured_prompts is
  'Opt-in captured request prompts (organizations.capture_prompt_content). The gateway ledger stays content-free; THIS table is the only place gateway prompt content ever lands, written by gateway_capture_prompt under the org flag, expired after 30 days. Store of record; the broadcast tick delivers rows to explicitly enabled destinations at-least-once.';

create index gateway_captured_prompts_org_captured_idx
  on public.gateway_captured_prompts (org_id, captured_at desc);
create index gateway_captured_prompts_export_idx
  on public.gateway_captured_prompts (captured_at)
  where exported_at is null;
create index gateway_captured_prompts_group_idx
  on public.gateway_captured_prompts (org_id, prompt_sha256, captured_at desc);

alter table public.gateway_captured_prompts enable row level security;
revoke all on table public.gateway_captured_prompts
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- WRITE: the worker's capture insert. Service-role only; re-checks the org
-- opt-in inside the transaction; idempotent per request.

create function public.gateway_capture_prompt(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_prompt_sha256 pg_catalog.text,
  p_messages pg_catalog.jsonb
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  -- The flag is the authority: a capture enqueued moments before an admin
  -- flipped the toggle off must not persist. FOR SHARE serializes against a
  -- concurrent settings UPDATE, so the flag cannot flip between this check
  -- and the insert below (both live in this function's one transaction).
  if not exists (
    select 1 from public.organizations orgs
     where orgs.id = p_org_id and orgs.capture_prompt_content
     for share
  ) then
    return;
  end if;
  if not exists (
    select 1 from public.gateway_requests requests
     where requests.request_id = p_request_id and requests.org_id = p_org_id
  ) then
    -- Unknown or foreign request id: never attach content to another org's row.
    return;
  end if;
  insert into public.gateway_captured_prompts (
    request_id, org_id, prompt_sha256, messages
  ) values (
    p_request_id, p_org_id, p_prompt_sha256, p_messages
  )
  on conflict (request_id) do nothing;
end;
$$;

revoke all on function public.gateway_capture_prompt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.gateway_capture_prompt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- READ: one request's captured prompt (the request log's expansion), and the
-- latest captured text snippet per prompt group (Insights labels).

create function public.gateway_captured_prompt_read(
  in_org pg_catalog.uuid,
  in_request_id pg_catalog.text
)
returns table (
  request_id pg_catalog.text,
  messages pg_catalog.jsonb,
  captured_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select captured.request_id, captured.messages, captured.captured_at
    from public.gateway_captured_prompts captured
   where captured.org_id = in_org and captured.request_id = in_request_id;
end;
$$;

revoke all on function public.gateway_captured_prompt_read(
  pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_captured_prompt_read(
  pg_catalog.uuid, pg_catalog.text
) to service_role;

create function public.gateway_prompt_group_snippets(
  in_org pg_catalog.uuid
)
returns table (
  prompt_sha256 pg_catalog.text,
  -- The system/developer prompt's first 160 characters from the LATEST
  -- captured request in the group; the caller renders it as the group label.
  snippet pg_catalog.text,
  captured_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select distinct on (captured.prompt_sha256)
    captured.prompt_sha256,
    pg_catalog.left(
      coalesce(
        (
          select message ->> 'content'
            from pg_catalog.jsonb_array_elements(captured.messages) as message
           where message ->> 'role' in ('system', 'developer')
             and message ->> 'content' is not null
           limit 1
        ),
        (
          select message ->> 'content'
            from pg_catalog.jsonb_array_elements(captured.messages) as message
           where message ->> 'content' is not null
           limit 1
        ),
        ''
      ),
      160
    ) as snippet,
    captured.captured_at
  from public.gateway_captured_prompts captured
  where captured.org_id = in_org and captured.prompt_sha256 is not null
  order by captured.prompt_sha256, captured.captured_at desc;
end;
$$;

revoke all on function public.gateway_prompt_group_snippets(
  pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.gateway_prompt_group_snippets(
  pg_catalog.uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- BROADCAST QUEUE: the scheduled tick's work queue — oldest undelivered rows
-- for orgs that hold the flag, and the stamp for delivered rows. Service-role
-- only (driven by the internal scheduled route, never by tenants).

create function public.gateway_captured_prompts_to_export(
  in_limit pg_catalog.int4 default 100,
  -- Orgs whose destination already failed this tick: excluding them here
  -- lets the drain loop reach other orgs' rows queued behind that backlog
  -- instead of head-of-line blocking on a down destination.
  in_exclude_orgs pg_catalog.uuid[] default '{}'
)
returns table (
  request_id pg_catalog.text,
  org_id pg_catalog.uuid,
  alias pg_catalog.text,
  prompt_sha256 pg_catalog.text,
  messages pg_catalog.jsonb,
  captured_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Revoked consent stops the EXTERNAL ship immediately: rows captured under
  -- an opt-in that has since been turned off are never broadcast (they stay
  -- readable in-product until retention or the privacy wipe removes them).
  return query
  select captured.request_id, captured.org_id, requests.alias,
         captured.prompt_sha256, captured.messages, captured.captured_at
    from public.gateway_captured_prompts captured
    join public.gateway_requests requests
      on requests.request_id = captured.request_id
    join public.organizations orgs
      on orgs.id = captured.org_id and orgs.capture_prompt_content
   where captured.exported_at is null
     and not (captured.org_id = any(coalesce(in_exclude_orgs, '{}')))
   order by captured.captured_at
   limit least(greatest(coalesce(in_limit, 100), 1), 500);
end;
$$;

-- The CLAIM half of claim-then-ship: stamps rows delivered inside one
-- transaction that re-verifies the org's CURRENT consent, and returns exactly
-- the claimed ids. The broadcaster ships only what this returned, so content
-- can never leave after revocation — the residual trade is a crash between
-- claim and ship losing one external delivery (the row stays in the platform
-- table), which is the right side of the trade for consent.
create function public.gateway_captured_prompts_mark_exported(
  p_request_ids pg_catalog.text[]
)
returns setof pg_catalog.text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  return query
  update public.gateway_captured_prompts captured
     set exported_at = pg_catalog.clock_timestamp()
   where captured.request_id = any(p_request_ids)
     and captured.exported_at is null
     and exists (
       select 1 from public.organizations orgs
        where orgs.id = captured.org_id and orgs.capture_prompt_content
     )
  returning captured.request_id;
end;
$$;

-- Compensation for a failed ship: release claimed rows back to the queue.
create function public.gateway_captured_prompts_unmark_exported(
  p_request_ids pg_catalog.text[]
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  update public.gateway_captured_prompts
     set exported_at = null
   where request_id = any(p_request_ids);
end;
$$;

revoke all on function public.gateway_captured_prompts_to_export(
  pg_catalog.int4, pg_catalog.uuid[]
) from public, anon, authenticated;
grant execute on function public.gateway_captured_prompts_to_export(
  pg_catalog.int4, pg_catalog.uuid[]
) to service_role;
revoke all on function public.gateway_captured_prompts_mark_exported(pg_catalog.text[])
  from public, anon, authenticated;
grant execute on function public.gateway_captured_prompts_mark_exported(pg_catalog.text[])
  to service_role;
revoke all on function public.gateway_captured_prompts_unmark_exported(pg_catalog.text[])
  from public, anon, authenticated;
grant execute on function public.gateway_captured_prompts_unmark_exported(pg_catalog.text[])
  to service_role;

-- ---------------------------------------------------------------------------
-- BROADCAST CONFIG: per-destination settings live on the org's stored
-- observability connection (trace_connections.config.broadcast — enabled +
-- privacy_mode). Broadcast is OFF unless explicitly enabled: connecting a
-- destination for trace ingestion never implicitly ships content to it.
-- This RPC patches config without touching the credential (the upsert RPC
-- requires a secret because it is connect-or-rotate).

create function public.update_trace_connection_config(
  in_org_id pg_catalog.uuid,
  in_kind pg_catalog.text,
  in_patch pg_catalog.jsonb
)
returns table (
  id pg_catalog.uuid,
  org_id pg_catalog.uuid,
  kind pg_catalog.text,
  config pg_catalog.jsonb,
  credential_last4 pg_catalog.text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.trace_connections connections
     set config = coalesce(connections.config, '{}'::pg_catalog.jsonb) || in_patch,
         updated_at = pg_catalog.now()
   where connections.org_id = in_org_id
     and connections.kind = lower(nullif(btrim(in_kind), ''))
  returning connections.id, connections.org_id, connections.kind,
            connections.config, connections.credential_last4;
end;
$$;

revoke all on function public.update_trace_connection_config(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.update_trace_connection_config(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- RETENTION: captured content expires after 30 days regardless of broadcast
-- state. Scheduled below alongside the existing maintenance jobs.

create function public.expire_captured_prompts()
returns pg_catalog.int4
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count pg_catalog.int4;
begin
  delete from public.gateway_captured_prompts
   where captured_at < pg_catalog.clock_timestamp() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_captured_prompts()
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- SCHEDULES. Retention runs in SQL directly (variant of
-- expire-synthetic-accounts); the broadcast tick runs through the internal
-- machine route so credential release and the destination HTTP calls stay in
-- the api process (same three-hop shape as account-balance-fetch). The tick
-- is every minute — destinations expect near-live traces — but an idle tick
-- costs one indexed exists-probe and no HTTP: the guard below skips the hop
-- whenever nothing is pending.

create function public.invoke_broadcast()
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  broadcast_url pg_catalog.text;
  bearer_secret pg_catalog.text;
begin
  if not exists (
    select 1 from public.gateway_captured_prompts captured
     where captured.exported_at is null
  ) then
    return;  -- nothing pending: no vault read, no HTTP
  end if;
  select secrets.decrypted_secret into broadcast_url
    from vault.decrypted_secrets secrets where secrets.name = 'broadcast_url';
  select secrets.decrypted_secret into bearer_secret
    from vault.decrypted_secrets secrets where secrets.name = 'cron_secret';
  if broadcast_url is null or bearer_secret is null then
    return;  -- local/dev stacks schedule nothing without the deploy secrets
  end if;
  perform net.http_post(
    url := broadcast_url,
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || bearer_secret
    )
  );
end;
$$;

revoke all on function public.invoke_broadcast()
  from public, anon, authenticated;

do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; capture jobs not scheduled';
    return;
  end if;
  perform cron.schedule(
    'expire-captured-prompts', '45 * * * *',
    'select public.expire_captured_prompts()'
  );
  perform cron.schedule(
    'broadcast', '* * * * *',
    'select public.invoke_broadcast()'
  );
end;
$$;
