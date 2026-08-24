-- Cost controls: per-KEY and per-MODEL budget scopes, and RECURRING budgets.
--
-- 1. Scopes. gateway_budgets governed team/identity/pool/deployment. The two
--    scopes operators actually reach for first were missing:
--      * key   -- one API key's monthly spend (an agent's wallet). Shape:
--                 (api_key_id). Coordinates come free at the reservation seam
--                 (the locked request row carries the key).
--      * model -- one alias's monthly spend across every pool/deployment
--                 under it (customer vocabulary: the model slug). Shape:
--                 (alias_id). Broader than pool, narrower than team.
--    New reservation SQLSTATEs: P1023 budget_key, P1024 budget_model (both
--    stop routing -- no sibling route escapes a key or model budget; only
--    deployment scope advances the waterfall).
--
-- 2. Recurring. A budget row was pinned to one 'YYYY-MM' and SILENTLY STOPPED
--    ENFORCING at month rollover -- an operator who set "this org spends at
--    most $500/month" got exactly one month of protection and an unlimited
--    lane afterwards. period = '*' now means "every month": the gate matches
--    it in every period and always measures the CURRENT UTC month's spend, so
--    the limit resets on the 1st and keeps enforcing. A '*' row and a pinned
--    row for the same scope may coexist (uniqueness includes period); both
--    must pass, so the pinned month acts as a one-month override only if it
--    is tighter.
--
-- Absence of a row is still unlimited; enforcement is still host-lane only,
-- reserve-time, lock-serialized, fail-closed on unknown price.

-- ---------------------------------------------------------------------------
-- 1. Table: new scope kinds, the key coordinate, recurring periods, and the
--    widened uniqueness. Constraint names are Postgres's deterministic
--    defaults for the inline checks created by 20260820090000.

alter table public.gateway_budgets
  drop constraint gateway_budgets_period_check;
alter table public.gateway_budgets
  add constraint gateway_budgets_period_check
    check (period ~ '^\d{4}-(0[1-9]|1[0-2])$' or period = '*');

alter table public.gateway_budgets
  drop constraint gateway_budgets_scope_kind_check;
alter table public.gateway_budgets
  add constraint gateway_budgets_scope_kind_check
    check (scope_kind in ('team', 'identity', 'key', 'model', 'pool', 'deployment'));

-- ON DELETE CASCADE like identity_id: a deleted key's budget row governs
-- nothing and would otherwise be unreachable garbage (spend history is
-- untouched -- budgets store limits only).
alter table public.gateway_budgets
  add column api_key_id pg_catalog.uuid
    references public.api_keys(id) on delete cascade;

alter table public.gateway_budgets
  drop constraint gateway_budgets_check;
alter table public.gateway_budgets
  add constraint gateway_budgets_check
  -- Exactly the identifiers owned by the selected scope:
  --   team:(none) identity:(identity_id) key:(api_key_id) model:(alias_id)
  --   pool:(alias_id,pool_id) deployment:(alias_id,pool_id,deployment_id).
  check (
    (scope_kind = 'team'       and identity_id is null and alias_id is null
       and pool_id is null and deployment_id is null and api_key_id is null) or
    (scope_kind = 'identity'   and identity_id is not null and alias_id is null
       and pool_id is null and deployment_id is null and api_key_id is null) or
    (scope_kind = 'key'        and api_key_id is not null and identity_id is null
       and alias_id is null and pool_id is null and deployment_id is null) or
    (scope_kind = 'model'      and alias_id is not null and identity_id is null
       and pool_id is null and deployment_id is null and api_key_id is null) or
    (scope_kind = 'pool'       and alias_id is not null and pool_id is not null
       and identity_id is null and deployment_id is null and api_key_id is null) or
    (scope_kind = 'deployment' and alias_id is not null and pool_id is not null
       and deployment_id is not null and identity_id is null and api_key_id is null)
  );

drop index public.gateway_budgets_scope_uniq;
create unique index gateway_budgets_scope_uniq
  on public.gateway_budgets (
    org_id, period, scope_kind,
    coalesce(identity_id, ''), coalesce(alias_id, ''),
    coalesce(pool_id, ''), coalesce(deployment_id, ''),
    coalesce(api_key_id::pg_catalog.text, '')
  );

comment on table public.gateway_budgets is
  'Monthly hard-limit scopes (team/identity/key/model/pool/deployment). Stores limit + scope only; balances derive from gateway_attempts at read. period is a pinned ''YYYY-MM'' or ''*'' (recurring: enforced every month against that month''s spend). Absence of a row = unlimited. Enforced at the reservation seam, host lane only.';

-- ---------------------------------------------------------------------------
-- 2. Scope spend helper: signature gains the key coordinate, arms gain
--    key/model. Signature change -> drop + create; stays ungranted (only the
--    definer reservation check calls it).

drop function public.gateway_budget_scope_spent(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz, pg_catalog.timestamptz
);

create function public.gateway_budget_scope_spent(
  p_org_id pg_catalog.uuid,
  p_scope_kind pg_catalog.text,
  p_api_key_id pg_catalog.uuid,
  p_identity_id pg_catalog.text,
  p_alias_id pg_catalog.text,
  p_pool_id pg_catalog.text,
  p_deployment_id pg_catalog.text,
  p_month_start pg_catalog.timestamptz,
  p_next_month pg_catalog.timestamptz
)
returns pg_catalog.int8
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(
    case when attempts.state = 'dispatched'
      then attempts.budget_reserved_micro_usd
      else coalesce(attempts.budget_settled_micro_usd, 0)
    end), 0)::pg_catalog.int8
  from public.gateway_attempts attempts
  where attempts.org_id = p_org_id
    and attempts.billing_source = 'host_managed'
    and attempts.budget_period_start >= p_month_start
    and attempts.budget_period_start < p_next_month
    and (
      p_scope_kind = 'team'
      -- Key scope reads the attempt's own denormalized key (20260822110000):
      -- no join, window-bounded via gateway_attempts_key_period_idx.
      or (p_scope_kind = 'key' and attempts.api_key_id = p_api_key_id)
      or (p_scope_kind = 'identity' and exists (
            select 1
              from public.gateway_requests requests
              join public.api_keys keys on keys.id = requests.api_key_id
             where requests.request_id = attempts.request_id
               and keys.identity_id = p_identity_id))
      -- Model scope is the alias across every pool/deployment under it,
      -- resolved through the request's frozen revision like pool/deployment.
      or (p_scope_kind = 'model' and exists (
            select 1
              from public.gateway_requests requests
              join public.gateway_alias_revisions revisions
                on revisions.revision_id = requests.alias_revision_id
             where requests.request_id = attempts.request_id
               and revisions.alias_id = p_alias_id))
      or (p_scope_kind in ('pool', 'deployment')
            and attempts.pool_id = p_pool_id
            and (p_scope_kind = 'pool'
                 or attempts.deployment_id = p_deployment_id)
            and exists (
              select 1
                from public.gateway_requests requests
                join public.gateway_alias_revisions revisions
                  on revisions.revision_id = requests.alias_revision_id
               where requests.request_id = attempts.request_id
                 and revisions.alias_id = p_alias_id))
    );
$$;

revoke all on function public.gateway_budget_scope_spent(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.timestamptz
) from public, anon, authenticated, service_role;

comment on function public.gateway_budget_scope_spent(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.timestamptz
) is
  'Charged-or-reserved host_managed spend (micro-USD) for one budget scope within a UTC month window: dispatched attempts count their reservation, terminal attempts their settled amount. Key scope reads attempts.api_key_id, identity resolves through the request key, model/pool/deployment through the request''s frozen alias revision.';

-- ---------------------------------------------------------------------------
-- 3. The reservation check: key coordinate, key/model arms, recurring match.
--    Signature change -> drop + create; stays ungranted.

drop function public.gateway_budget_reservation_check(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.int8
);

create function public.gateway_budget_reservation_check(
  p_org_id pg_catalog.uuid,
  p_api_key_id pg_catalog.uuid,
  p_identity_id pg_catalog.text,
  p_alias_id pg_catalog.text,
  p_pool_id pg_catalog.text,
  p_deployment_id pg_catalog.text,
  p_proposed_micro_usd pg_catalog.int8
)
returns table (
  allowed pg_catalog.bool,
  reason_code pg_catalog.text,
  message pg_catalog.text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Nullable on purpose: a null proposed cost means the route's worst case is
  -- unknown, which cannot be bounded against a finite budget (handled below).
  v_proposed pg_catalog.int8 := p_proposed_micro_usd;
  v_utc_now pg_catalog.timestamp;
  v_month_floor pg_catalog.timestamp;
  v_period pg_catalog.text;
  v_month_start pg_catalog.timestamptz;
  v_next_month pg_catalog.timestamptz;
  v_budget public.gateway_budgets%rowtype;
  v_spent pg_catalog.int8;
  v_scope_label pg_catalog.text;
  v_period_label pg_catalog.text;
begin
  -- The month window is derived from UTC wall time so it is timezone-agnostic:
  -- date_trunc on the UTC-shifted timestamp gives the first of the month, and
  -- to_char formats the same value into the 'YYYY-MM' period key P-A stores.
  -- A recurring ('*') budget matches every period and is always measured
  -- against the CURRENT month's window, which is what makes it reset on the
  -- 1st instead of expiring.
  v_utc_now := pg_catalog.clock_timestamp() at time zone 'UTC';
  v_month_floor := pg_catalog.date_trunc('month', v_utc_now);
  v_period := pg_catalog.to_char(v_month_floor, 'YYYY-MM');
  v_month_start := v_month_floor at time zone 'UTC';
  v_next_month := (v_month_floor + pg_catalog.interval '1 month') at time zone 'UTC';

  for v_budget in
    select budgets.*
      from public.gateway_budgets budgets
     where budgets.org_id = p_org_id
       and budgets.period in (v_period, '*')
       and (
         budgets.scope_kind = 'team'
         or (budgets.scope_kind = 'identity'
               and budgets.identity_id = p_identity_id)
         or (budgets.scope_kind = 'key'
               and budgets.api_key_id = p_api_key_id)
         or (budgets.scope_kind = 'model'
               and budgets.alias_id = p_alias_id)
         or (budgets.scope_kind = 'pool'
               and budgets.alias_id = p_alias_id
               and budgets.pool_id = p_pool_id)
         or (budgets.scope_kind = 'deployment'
               and budgets.alias_id = p_alias_id
               and budgets.pool_id = p_pool_id
               and budgets.deployment_id = p_deployment_id)
       )
     -- Tightest scope first: a dispatch capped at several levels reports the
     -- most specific budget the operator would raise.
     order by case budgets.scope_kind
       when 'deployment' then 0
       when 'pool' then 1
       when 'model' then 2
       when 'key' then 3
       when 'identity' then 4
       else 5
     end
  loop
    v_spent := public.gateway_budget_scope_spent(
      p_org_id, v_budget.scope_kind, v_budget.api_key_id, v_budget.identity_id,
      v_budget.alias_id, v_budget.pool_id, v_budget.deployment_id,
      v_month_start, v_next_month
    );
    -- An unknown worst-case cost (v_proposed is null) cannot be bounded, so any
    -- governing budget rejects it. Tightest-scope-first ordering means a
    -- deployment budget still advances the waterfall to a sibling route while
    -- the coarser scopes stop routing.
    if v_proposed is null or v_spent + v_proposed > v_budget.limit_micro_usd then
      v_scope_label := case v_budget.scope_kind
        when 'team' then 'organization'
        when 'identity' then 'identity ' || v_budget.identity_id
        when 'key' then 'API key ' || coalesce(
          (select keys.name from public.api_keys keys
            where keys.id = v_budget.api_key_id),
          v_budget.api_key_id::pg_catalog.text)
        when 'model' then 'model ' || v_budget.alias_id
        when 'pool' then 'pool ' || v_budget.pool_id
        when 'deployment' then 'deployment ' || v_budget.deployment_id
      end;
      v_period_label := case
        when v_budget.period = '*'
          then 'recurring monthly budget (currently ' || v_period || ')'
        else 'monthly budget for ' || v_period
      end;
      return query select
        false,
        ('budget_' || v_budget.scope_kind)::pg_catalog.text,
        ('budget_' || v_budget.scope_kind || ': this request''s worst case ('
         || case
              when v_proposed is null then 'unknown cost'
              else '$' || pg_catalog.to_char(
                v_proposed::pg_catalog.numeric / 1000000, 'FM999999990.00')
            end
         || ') would push the ' || v_scope_label || ' past its $'
         || pg_catalog.to_char(
              v_budget.limit_micro_usd::pg_catalog.numeric / 1000000,
              'FM999999990.00')
         || ' ' || v_period_label || ' (UTC; $'
         || pg_catalog.to_char(
              v_spent::pg_catalog.numeric / 1000000, 'FM999999990.00')
         || ' already reserved or settled this month, resets 00:00 UTC on the '
         || '1st). Raise or remove this budget in Settings -> Identities & '
         || 'access -> Budgets (' || public.gateway_webapp_url()
         || ').')::pg_catalog.text;
      return;
    end if;
  end loop;

  return query select true, null::pg_catalog.text, null::pg_catalog.text;
end;
$$;

revoke all on function public.gateway_budget_reservation_check(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated, service_role;

comment on function public.gateway_budget_reservation_check(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.int8
) is
  'Reserve-time per-scope monthly budget gate for one host_managed dispatch. Returns billing''s (allowed, reason_code, message) shape; reason_code is budget_{team,identity,key,model,pool,deployment}. Matches pinned-month and recurring (''*'') rows. Meaningful only under the organizations row lock (reservation-aware). Composed alongside gateway_spend_policy_check in gateway_start_attempt -- both must pass.';

-- ---------------------------------------------------------------------------
-- 4. Balances read seam: mirrors the new arms so the meter equals the gate,
--    and now reports period + api_key_id so the API can render pinned vs
--    recurring and the key scope. Return shape change -> drop + create,
--    grants re-issued. Reading a month includes the recurring rows measured
--    over THAT month's window.

drop function public.gateway_budget_balances(pg_catalog.uuid, pg_catalog.text);

create function public.gateway_budget_balances(
  p_org_id pg_catalog.uuid,
  p_period pg_catalog.text
)
returns table (
  budget_id pg_catalog.text,
  period pg_catalog.text,
  scope_kind pg_catalog.text,
  api_key_id pg_catalog.uuid,
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
  -- enforcement helper does. Recurring ('*') budgets appear in every month's
  -- read, metered over the requested month's window.
  with bounds as (
    select
      (((p_period || '-01')::pg_catalog.date)::pg_catalog.timestamp
         at time zone 'UTC') as month_start,
      ((((p_period || '-01')::pg_catalog.date) + pg_catalog.interval '1 month')
         ::pg_catalog.timestamp at time zone 'UTC') as next_month
  )
  select
    budgets.budget_id,
    budgets.period,
    budgets.scope_kind,
    budgets.api_key_id,
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
        or (budgets.scope_kind = 'key'
              and attempts.api_key_id = budgets.api_key_id)
        or (budgets.scope_kind = 'identity' and exists (
              select 1
                from public.gateway_requests requests
                join public.api_keys keys on keys.id = requests.api_key_id
               where requests.request_id = attempts.request_id
                 and keys.identity_id = budgets.identity_id))
        or (budgets.scope_kind = 'model' and exists (
              select 1
                from public.gateway_requests requests
                join public.gateway_alias_revisions revisions
                  on revisions.revision_id = requests.alias_revision_id
               where requests.request_id = attempts.request_id
                 and revisions.alias_id = budgets.alias_id))
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
    and budgets.period in (p_period, '*')
  order by
    case budgets.scope_kind
      when 'team' then 0 when 'identity' then 1 when 'key' then 2
      when 'model' then 3 when 'pool' then 4 else 5 end,
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
  'P-D budgets read seam: one row per gateway_budgets scope governing an org+month (pinned rows for that month plus recurring ''*'' rows) with its limit and split reserved (dispatched) / settled (terminal) host_managed spend, using the same scope resolution as gateway_budget_reservation_check so the meter equals the gate. SECURITY DEFINER, service_role-executable.';
