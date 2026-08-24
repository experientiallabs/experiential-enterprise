-- Keep the repair path aligned with every trigger-maintained spend source.
-- This must follow the main-branch repair migration, which predates local Pi
-- runs and therefore does not include them in its replacement function body.
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
       + coalesce((
      select sum(coalesce(local_pi.cost_usd, 0))
        from public.local_pi_runs local_pi
       where local_pi.org_id = target_org), 0)
    into total;
  update public.organizations set spend_usd = total where id = target_org;
  return total;
end;
$$;
