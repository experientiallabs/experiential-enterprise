-- Admin-controllable, re-triggerable "welcome celebration" (the product owner, 2026-09-01).
--
-- The confetti + API-key + integration-prompt modal (the LoginModal "success"
-- step) already fires once for a brand-new account. This makes it re-triggerable
-- on a member's NEXT workspace enter, controlled per org (and per label cohort)
-- by a platform admin: toggle on/off, choose the credit amount to display, and
-- whether to show the API key. Immediate use: turn it on for every `yc`-labelled
-- org with $526 so each YC founder sees "$526 in credits applied" on next enter.
--
-- Model: an org-level trigger carries `active`, the display amount, and a
-- `triggered_at` that BUMPS every time an admin (re)activates. A per-user "seen"
-- row records the triggered_at that user last saw. "Should show" =
--   trigger.active AND (no seen row OR seen.seen_triggered_at < trigger.triggered_at),
-- so re-activating (a fresh triggered_at) shows it again even to prior viewers.

-- ---------------------------------------------------------------------------
-- 1. The org-level trigger (admin-written; members read their own).

create table public.org_welcome_trigger (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  active boolean not null default false,
  -- The credit figure to ANNOUNCE in the modal. NULL = fall back to the org's
  -- launch-grant amount (readLaunchGrantUsd). Not a balance; a display value.
  display_credit_usd numeric(14, 6),
  show_api_key boolean not null default true,
  -- Bumped on every (re)activation so prior viewers see the celebration again.
  triggered_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

comment on table public.org_welcome_trigger is
  'Per-org admin control for the re-triggerable welcome celebration (confetti + API key + integration prompt). active + a fresh triggered_at re-shows it on members'' next workspace enter.';

alter table public.org_welcome_trigger enable row level security;

-- Writes are admin/service-role only; members may READ their own org's trigger
-- so the shell can decide whether to celebrate. An RLS policy is not enough on
-- its own — the TABLE grant is required too (the org_labels regression, #775).
revoke all on table public.org_welcome_trigger from public, anon, authenticated, service_role;
grant select on public.org_welcome_trigger to authenticated;
grant select, insert, update, delete on public.org_welcome_trigger to service_role;

create policy org_welcome_trigger_select_member
  on public.org_welcome_trigger
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- ---------------------------------------------------------------------------
-- 2. The per-user "seen" marker (each member reads/writes their own).

create table public.user_welcome_trigger_seen (
  user_id uuid not null,
  org_id uuid not null references public.organizations(id) on delete cascade,
  seen_triggered_at timestamptz not null,
  primary key (user_id, org_id)
);

comment on table public.user_welcome_trigger_seen is
  'Which org_welcome_trigger.triggered_at a user has already been shown, per org. No FK to auth.users (GoTrue owns it); the id is trusted from the verified JWT.';

alter table public.user_welcome_trigger_seen enable row level security;

revoke all on table public.user_welcome_trigger_seen from public, anon, authenticated, service_role;
grant select, insert, update on public.user_welcome_trigger_seen to authenticated;
grant select, insert, update, delete on public.user_welcome_trigger_seen to service_role;

create policy user_welcome_trigger_seen_select_own
  on public.user_welcome_trigger_seen
  for select
  to authenticated
  using (user_id = public.authenticated_user_id());

create policy user_welcome_trigger_seen_insert_own
  on public.user_welcome_trigger_seen
  for insert
  to authenticated
  with check (user_id = public.authenticated_user_id());

create policy user_welcome_trigger_seen_update_own
  on public.user_welcome_trigger_seen
  for update
  to authenticated
  using (user_id = public.authenticated_user_id())
  with check (user_id = public.authenticated_user_id());

-- ---------------------------------------------------------------------------
-- 3. Admin write functions (service-role definer; the FastAPI admin routes and
--    the superadmin key reach them). Members never write the trigger.

-- Upsert one org's trigger. Activating (in_active = true) BUMPS triggered_at to
-- now() so every prior viewer sees the celebration again on next enter;
-- deactivating leaves triggered_at untouched (a later reactivation is what
-- re-shows it). Returns the resulting row.
create function public.set_org_welcome_trigger(
  in_org pg_catalog.uuid,
  in_active pg_catalog.bool,
  in_display_credit_usd pg_catalog.numeric,
  in_show_api_key pg_catalog.bool,
  in_updated_by pg_catalog.uuid
)
returns setof public.org_welcome_trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  insert into public.org_welcome_trigger
      (org_id, active, display_credit_usd, show_api_key, triggered_at, updated_by, updated_at)
    values (in_org, in_active, in_display_credit_usd, in_show_api_key, now(), in_updated_by, now())
  on conflict (org_id) do update set
    active = excluded.active,
    display_credit_usd = excluded.display_credit_usd,
    show_api_key = excluded.show_api_key,
    -- Re-arm on activation only; a deactivate keeps the last triggered_at so it
    -- is not treated as a fresh celebration if flipped back on unchanged.
    triggered_at = case when excluded.active
      then now() else public.org_welcome_trigger.triggered_at end,
    updated_by = excluded.updated_by,
    updated_at = now();
  return query
    select t.* from public.org_welcome_trigger t where t.org_id = in_org;
end;
$$;

revoke all on function public.set_org_welcome_trigger(
  pg_catalog.uuid, pg_catalog.bool, pg_catalog.numeric, pg_catalog.bool, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.set_org_welcome_trigger(
  pg_catalog.uuid, pg_catalog.bool, pg_catalog.numeric, pg_catalog.bool, pg_catalog.uuid
) to service_role;

-- Apply the same trigger settings to EVERY org carrying a given label (the
-- cohort lane: "arm the welcome for all `yc` orgs"). Returns the org count.
create function public.apply_welcome_trigger_by_label(
  in_key pg_catalog.text,
  in_active pg_catalog.bool,
  in_display_credit_usd pg_catalog.numeric,
  in_show_api_key pg_catalog.bool,
  in_updated_by pg_catalog.uuid
)
returns pg_catalog.int4
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected pg_catalog.int4;
begin
  perform public.gateway_require_service_role();
  with targets as (
    select org_id from public.org_labels where key = in_key
  ), upserted as (
    insert into public.org_welcome_trigger
        (org_id, active, display_credit_usd, show_api_key, triggered_at, updated_by, updated_at)
      select org_id, in_active, in_display_credit_usd, in_show_api_key, now(), in_updated_by, now()
        from targets
    on conflict (org_id) do update set
      active = excluded.active,
      display_credit_usd = excluded.display_credit_usd,
      show_api_key = excluded.show_api_key,
      triggered_at = case when excluded.active
        then now() else public.org_welcome_trigger.triggered_at end,
      updated_by = excluded.updated_by,
      updated_at = now()
    returning 1
  )
  select count(*)::pg_catalog.int4 into affected from upserted;
  return affected;
end;
$$;

revoke all on function public.apply_welcome_trigger_by_label(
  pg_catalog.text, pg_catalog.bool, pg_catalog.numeric, pg_catalog.bool, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.apply_welcome_trigger_by_label(
  pg_catalog.text, pg_catalog.bool, pg_catalog.numeric, pg_catalog.bool, pg_catalog.uuid
) to service_role;
