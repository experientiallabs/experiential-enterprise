-- Per-endpoint serving spend for the usage rollup. The Settings usage page
-- folds org_usage_view from sessions/rollouts/builds; serving traffic was
-- counted by the budget trigger (organizations.spend_usd) but invisible in
-- the breakdown, so "Remaining" overstated credit while the sidebar meter and
-- the 402 enforcement disagreed two inches away. This RPC is the read the
-- fold was missing: one row per endpoint that has served traffic, with the
-- priced total and the unpriced count (null cost_usd = unpriced, never $0).
--
-- Same access model as the other serving reads (20260723120000): definer,
-- service-role only, no routing fields, label from the newest row.
--
-- Replace-safe like every other object in this file: a re-applied migration
-- (a db provisioned before this version was recorded in the ledger, or a
-- retried partial apply) must not crash on an already-created function.
create or replace function public.serving_usage_rollup(in_org uuid)
returns table (
  endpoint_id uuid,
  endpoint_label text,
  request_count bigint,
  unpriced_count bigint,
  cost_usd numeric
)
language sql
security definer
set search_path = ''
as $$
  select
    requests.endpoint_id,
    (array_agg(requests.endpoint_label order by requests.created_at desc))[1]
      as endpoint_label,
    count(*) as request_count,
    count(*) filter (where requests.cost_usd is null) as unpriced_count,
    coalesce(sum(requests.cost_usd), 0) as cost_usd
  from public.serving_requests requests
  where requests.org_id = in_org
  group by requests.endpoint_id
  order by cost_usd desc;
$$;

revoke all on function public.serving_usage_rollup(uuid) from public, anon, authenticated;
grant execute on function public.serving_usage_rollup(uuid) to service_role;

-- Serving spend feeds the org budget counter like every other metered table
-- (house convention per 20260713160000: the trigger and the repair term land
-- with the surface that reads them). Guarded so the serving-wrapper branch,
-- which shipped the same objects while this migration was in review, applies
-- cleanly in either order.
create or replace function public.track_serving_request_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.apply_org_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
  end if;
  return null;
end;
$$;

drop trigger if exists track_serving_request_spend on public.serving_requests;
create trigger track_serving_request_spend
after insert or update of org_id, cost_usd or delete on public.serving_requests
for each row execute function public.track_serving_request_spend();

-- Repair path gains the serving term (eighth source).
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
       + coalesce((
      select sum(coalesce(serving.cost_usd, 0))
        from public.serving_requests serving
       where serving.org_id = target_org), 0)
    into total;
  update public.organizations set spend_usd = total where id = target_org;
  return total;
end;
$$;

-- One-time true-up: serving rows inserted before this trigger existed (the
-- demo seeds) never moved the counter; reconcile every org once so the meter,
-- the page, and the enforcement agree from this migration forward.
select public.recompute_org_spend(orgs.id)
  from public.organizations orgs
 where exists (
   select 1 from public.serving_requests requests where requests.org_id = orgs.id
 );
