-- Fixes surfaced by exercising the pgTAP contract suite against a hosted
-- preview branch (the Preview Integration step this PR introduces).
--
-- 1. NULL-safe admin gates. invitee_account_state and admin_user_id_for_email
--    OR their admin checks with a `jwt-role = 'service_role'` comparison. In
--    sessions carrying no JWT claims GUC at all (psql, pgTAP, direct pooler
--    connections) that comparison is NULL, the whole IF condition folds to
--    NULL, and plpgsql treats it as false -- the raise is skipped and the gate
--    silently admits any caller. PostgREST always sets the claims, so the app
--    path enforced correctly, but the database boundary must fail loudly on
--    its own. A final empty-string coalesce arm keeps the comparison
--    two-valued. (admin_list_org_members already used the NULL-safe shape.)
--
-- 2. recompute_org_spend lost its agent_cost_reports term when
--    20260711040000 added live agent sessions to the fold. The counter
--    triggers still apply report spend on insert/update/delete, so the drift
--    repair diverged from the very counters it exists to reconcile. Restore
--    the term alongside the session one.

create or replace function public.invitee_account_state(target_org_id uuid, target_email text)
returns text
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  normalized text := lower(target_email);
  invitee_id uuid;
begin
  -- The org-invite route calls this through the service-role client (its
  -- own org-admin check already ran app-side); browser sessions must hold
  -- an admin role themselves.
  if not (
    public.is_platform_admin()
    or coalesce(
         nullif(current_setting('request.jwt.claim.role', true), ''),
         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
         ''
       ) = 'service_role'
    or (target_org_id is not null and public.is_org_admin(target_org_id))
  ) then
    raise exception 'organization admin required';
  end if;

  select users.id into invitee_id from auth.users users where lower(users.email) = normalized;
  if invitee_id is null then
    return 'none';
  end if;
  if target_org_id is not null and exists (
    select 1 from public.organization_members members
    where members.org_id = target_org_id and members.user_id = invitee_id
  ) then
    return 'member';
  end if;
  return 'user';
end;
$$;

create or replace function public.admin_user_id_for_email(target_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  found uuid;
begin
  if not (
    public.is_platform_admin()
    or coalesce(
         nullif(current_setting('request.jwt.claim.role', true), ''),
         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
         ''
       ) = 'service_role'
  ) then
    raise exception 'platform admin required';
  end if;
  select users.id into found from auth.users users where lower(users.email) = lower(target_email);
  return found;
end;
$$;

create or replace function public.recompute_org_spend(target_org uuid)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  total numeric;
begin
  select coalesce((
      select sum(coalesce(sessions.cost_usd, 0))
        from public.wm_sessions sessions
       where sessions.org_id = target_org), 0)
       + coalesce((
      select sum(coalesce(rollouts.cost_usd, 0) + coalesce(rollouts.wm_cost_usd, 0))
        from public.wm_rollouts rollouts
       where rollouts.org_id = target_org), 0)
       + coalesce((
      select sum(public.build_usage_spend(jobs.usage))
        from public.build_jobs jobs
       where jobs.org_id = target_org), 0)
       + coalesce((
      select sum(public.opt_run_usage_spend(runs.usage))
        from public.agent_opt_runs runs
       where runs.org_id = target_org), 0)
       + coalesce((
      select sum(public.cost_report_usage_spend(reports.usage))
        from public.agent_cost_reports reports
       where reports.org_id = target_org), 0)
       + coalesce((
      select sum(coalesce(live.cost_usd, 0))
        from public.agent_sessions live
       where live.org_id = target_org), 0)
    into total;
  update public.organizations set spend_usd = total where id = target_org;
  return total;
end;
$$;
