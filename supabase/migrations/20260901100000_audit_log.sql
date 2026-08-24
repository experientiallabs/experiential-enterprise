-- Security audit log (E7 core half): who-CHANGED-what, distinct from the
-- request telemetry stream (gateway_requests/attempts/usage_events records
-- who-called-what). One durable, append-only row per control-plane mutation.
--
-- Write path is an explicit emit, never a trigger: every sensitive write
-- arrives over service-role, where authenticated_user_id() is null, so a
-- trigger-only design would capture null actors for exactly the writes that
-- matter. The F2 emit seams (Python record_audit_event helper, web
-- equivalent) call the definer RPC below with the actor in hand.
--
-- org_id deliberately carries NO foreign key: organizations may be deleted,
-- and their audit history must survive the deletion cascade. Null org_id is
-- a platform-scope event (signup gate flips, platform-admin grants).
--
-- Retention is indefinite by design until a partitioning + retention design
-- ships (E14): the append-only trigger blocks naive pruning on purpose, so
-- any future retention limit is a deliberate schema change, not a DELETE job.

create table public.audit_log (
  event_id    pg_catalog.uuid primary key default pg_catalog.gen_random_uuid(),
  org_id      pg_catalog.uuid,
  actor_kind  pg_catalog.text not null
    check (actor_kind in ('user', 'api_key', 'platform_admin', 'system')),
  -- user uuid / api_key id / system label; free text because the actor
  -- namespaces differ per kind and the referenced row may be deleted later.
  actor_id    pg_catalog.text,
  -- Registry-style verb, e.g. 'keys.revoke', 'aliases.repoint'.
  action      pg_catalog.text not null,
  object_type pg_catalog.text not null,
  object_id   pg_catalog.text not null,
  -- Redacted snapshots (never secret material); null when not applicable.
  before      pg_catalog.jsonb,
  after       pg_catalog.jsonb,
  -- Request context: ip, user_agent, path, api surface.
  context     pg_catalog.jsonb not null default '{}'::pg_catalog.jsonb,
  created_at  pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

-- The org-admin viewer reads newest-first per org, optionally narrowed to
-- one action; both shapes get a covering index.
create index audit_log_org_created_idx
  on public.audit_log (org_id, created_at desc);

create index audit_log_org_action_created_idx
  on public.audit_log (org_id, action, created_at desc);

comment on table public.audit_log is
  'Append-only security audit log: one row per control-plane mutation, written only by record_audit_event from the F2 emit seams. org_id has no FK so audit history survives org deletion; null org_id = platform-scope event.';

-- ---------------------------------------------------------------------------
-- Append-only for everyone, service_role and table owner included: audit
-- history is evidence, and the trigger fires regardless of role or grants.

create function public.audit_log_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only security history';
end;
$$;

revoke all on function public.audit_log_block_mutation()
  from public, anon, authenticated, service_role;

create trigger audit_log_append_only
before update or delete on public.audit_log
for each row execute function public.audit_log_block_mutation();

-- ---------------------------------------------------------------------------
-- Row security and grants: the gateway-table pattern. RLS on with zero
-- policies, no direct write privilege for anyone; service_role reads, and
-- the only write path is the definer RPC below.

alter table public.audit_log enable row level security;

revoke all on table public.audit_log
  from public, anon, authenticated, service_role;

grant select on table public.audit_log to service_role;

-- ---------------------------------------------------------------------------
-- Writer RPC: the single sanctioned write path (F2's emit seam target).

create function public.record_audit_event(
  p_org_id pg_catalog.uuid,
  p_actor_kind pg_catalog.text,
  p_actor_id pg_catalog.text,
  p_action pg_catalog.text,
  p_object_type pg_catalog.text,
  p_object_id pg_catalog.text,
  p_before pg_catalog.jsonb default null,
  p_after pg_catalog.jsonb default null,
  p_context pg_catalog.jsonb default null
)
returns pg_catalog.uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id pg_catalog.uuid;
begin
  perform public.gateway_require_service_role();
  -- Raise a typed error ahead of the table CHECK so the emit seams get a
  -- self-explanatory message instead of a bare constraint violation.
  if p_actor_kind is null
     or p_actor_kind not in ('user', 'api_key', 'platform_admin', 'system') then
    raise exception using errcode = '23514',
      message = 'audit event actor_kind must be one of user, api_key, platform_admin, system';
  end if;
  insert into public.audit_log (
    org_id, actor_kind, actor_id, action, object_type, object_id,
    before, after, context
  ) values (
    p_org_id, p_actor_kind, p_actor_id, p_action, p_object_type, p_object_id,
    p_before, p_after, coalesce(p_context, '{}'::pg_catalog.jsonb)
  )
  returning event_id into v_event_id;
  return v_event_id;
end;
$$;

revoke all on function public.record_audit_event(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.record_audit_event(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- Reader RPC for the org-scoped audit viewer (/ee surface). Org-scoped on
-- purpose: platform-scope (null org) events need a distinct platform-admin
-- surface, not a null loophole here.

create function public.audit_log_read(
  in_org_id pg_catalog.uuid,
  in_action pg_catalog.text default null,
  in_object_type pg_catalog.text default null,
  in_actor_id pg_catalog.text default null,
  in_before pg_catalog.timestamptz default null,
  in_limit pg_catalog.int4 default 50
)
returns setof public.audit_log
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  if in_org_id is null then
    raise exception using errcode = '22023',
      message = 'audit_log_read requires an organization id';
  end if;
  return query
    select events.*
      from public.audit_log events
     where events.org_id = in_org_id
       and (in_action is null or events.action = in_action)
       and (in_object_type is null or events.object_type = in_object_type)
       and (in_actor_id is null or events.actor_id = in_actor_id)
       and (in_before is null or events.created_at < in_before)
     order by events.created_at desc, events.event_id desc
     limit least(greatest(coalesce(in_limit, 50), 1), 200);
end;
$$;

revoke all on function public.audit_log_read(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.audit_log_read(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.int4
) to service_role;
