-- Gateway identity tier P-D: the budgets READ seam.
--
-- P-C (20260820100000) made monthly budgets enforced at the reservation seam
-- and left an internal helper, gateway_budget_scope_spent, that sums one
-- scope's charged-or-reserved host_managed spend for a UTC month. That helper
-- is deliberately ungranted (like gateway_attempt_cost_micro_usd): only the
-- SECURITY DEFINER reservation check calls it. P-D's management API needs the
-- same numbers to render per-budget meters, but split into RESERVED (in-flight
-- dispatched attempts) and SETTLED (terminal attempts) so an operator can see
-- what a budget has actually spent versus what is still outstanding.
--
-- This migration adds gateway_budget_balances(org, period): one row per budget
-- for that org+period carrying its limit plus its reserved and settled spend,
-- computed from gateway_attempts with the SAME scope resolution the enforcement
-- helper uses (identity through the request key, pool/deployment through the
-- request's frozen alias revision). It is the single read the budgets API
-- calls; remaining is limit - (reserved + settled), derived by the caller. It
-- is SECURITY DEFINER and granted to service_role because the management API
-- reaches it as service_role over PostgREST rpc; the underlying attempt reads
-- run as the definer, so no direct service_role grant on gateway_attempts is
-- implied. The combined (reserved + settled) equals exactly what
-- gateway_budget_scope_spent returns and what enforcement counts, so the meter
-- can never disagree with the gate.

create function public.gateway_budget_balances(
  p_org_id pg_catalog.uuid,
  p_period pg_catalog.text
)
returns table (
  budget_id pg_catalog.text,
  scope_kind pg_catalog.text,
  identity_id pg_catalog.text,
  alias_id pg_catalog.text,
  pool_id pg_catalog.text,
  deployment_id pg_catalog.text,
  limit_micro_usd pg_catalog.int8,
  reserved_micro_usd pg_catalog.int8,
  settled_micro_usd pg_catalog.int8
)
language sql
stable
security definer
set search_path = ''
as $$
  -- The month window is derived from the 'YYYY-MM' period key itself so a read
  -- for a past or future month reports that month, not the wall clock: the
  -- first of the month is interpreted as UTC wall time exactly as the
  -- enforcement helper does (date_trunc('month', now at UTC) at time zone UTC).
  with bounds as (
    select
      (((p_period || '-01')::pg_catalog.date)::pg_catalog.timestamp
         at time zone 'UTC') as month_start,
      ((((p_period || '-01')::pg_catalog.date) + pg_catalog.interval '1 month')
         ::pg_catalog.timestamp at time zone 'UTC') as next_month
  )
  select
    budgets.budget_id,
    budgets.scope_kind,
    budgets.identity_id,
    budgets.alias_id,
    budgets.pool_id,
    budgets.deployment_id,
    budgets.limit_micro_usd,
    coalesce(spend.reserved_micro_usd, 0)::pg_catalog.int8,
    coalesce(spend.settled_micro_usd, 0)::pg_catalog.int8
  from public.gateway_budgets budgets
  cross join bounds
  left join lateral (
    select
      pg_catalog.sum(
        case when attempts.state = 'dispatched'
          then attempts.budget_reserved_micro_usd else 0 end) as reserved_micro_usd,
      pg_catalog.sum(
        case when attempts.state <> 'dispatched'
          then coalesce(attempts.budget_settled_micro_usd, 0) else 0 end) as settled_micro_usd
    from public.gateway_attempts attempts
    where attempts.org_id = budgets.org_id
      and attempts.billing_source = 'host_managed'
      and attempts.budget_period_start >= bounds.month_start
      and attempts.budget_period_start < bounds.next_month
      and (
        budgets.scope_kind = 'team'
        or (budgets.scope_kind = 'identity' and exists (
              select 1
                from public.gateway_requests requests
                join public.api_keys keys on keys.id = requests.api_key_id
               where requests.request_id = attempts.request_id
                 and keys.identity_id = budgets.identity_id))
        or (budgets.scope_kind in ('pool', 'deployment')
              and attempts.pool_id = budgets.pool_id
              and (budgets.scope_kind = 'pool'
                   or attempts.deployment_id = budgets.deployment_id)
              and exists (
                select 1
                  from public.gateway_requests requests
                  join public.gateway_alias_revisions revisions
                    on revisions.revision_id = requests.alias_revision_id
                 where requests.request_id = attempts.request_id
                   and revisions.alias_id = budgets.alias_id))
      )
  ) spend on true
  where budgets.org_id = p_org_id
    and budgets.period = p_period
  order by
    case budgets.scope_kind
      when 'team' then 0 when 'identity' then 1 when 'pool' then 2 else 3 end,
    budgets.budget_id;
$$;

revoke all on function public.gateway_budget_balances(
  pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated, service_role;

grant execute on function public.gateway_budget_balances(
  pg_catalog.uuid, pg_catalog.text
) to service_role;

comment on function public.gateway_budget_balances(
  pg_catalog.uuid, pg_catalog.text
) is
  'P-D budgets read seam: one row per gateway_budgets scope for an org+month with its limit and split reserved (dispatched) / settled (terminal) host_managed spend, using the same scope resolution as gateway_budget_reservation_check so the meter equals the gate. SECURITY DEFINER, service_role-executable (the management API reads it over rpc).';
