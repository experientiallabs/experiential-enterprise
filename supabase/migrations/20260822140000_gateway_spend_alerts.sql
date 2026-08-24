-- Cost controls: SPEND ALERTS -- notify before a limit bites.
--
-- Budgets and caps are hard gates: the first warning an operator gets today
-- is refused traffic (429). An alert is the soft counterpart: "tell me when
-- this month's spend crosses $X" / "tell me when a budget is 80% consumed",
-- delivered by email while requests still flow. Two rule kinds:
--
--   * org_monthly_spend -- fires when the org's charged-or-reserved host-lane
--     spend for the current UTC month crosses threshold_micro_usd.
--   * budget_fraction   -- fires when a gateway_budgets row governing the
--     current month (pinned or recurring) has consumed >= threshold_fraction
--     of its limit.
--
-- Delivery pipeline mirrors the proven daily-summary shape: pg_cron ->
-- invoke_spend_alerts() (Vault url + cron secret; silent no-op when either is
-- absent, e.g. local dev) -> the CRON-guarded web route -> Resend email. The
-- database CLAIMS atomically (gateway_spend_alert_events row, once per alert
-- per month); the route only sends and marks, so a crashed tick re-sends
-- undelivered claims on the next tick and can never double-fire a period.
-- Measurement reuses gateway_budget_scope_spent, so an alert can never
-- disagree with the gate it warns about.

create table public.gateway_spend_alerts (
  alert_id   pg_catalog.text primary key
    check (pg_catalog.char_length(alert_id) between 1 and 128),
  org_id     pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  kind       pg_catalog.text not null
    check (kind in ('org_monthly_spend', 'budget_fraction')),
  threshold_micro_usd pg_catalog.int8
    check (threshold_micro_usd is null or threshold_micro_usd > 0),
  budget_id  pg_catalog.text
    references public.gateway_budgets(budget_id) on delete cascade,
  threshold_fraction pg_catalog.numeric(4, 3)
    check (threshold_fraction is null
           or (threshold_fraction > 0 and threshold_fraction <= 1)),
  notify_email pg_catalog.text not null
    check (pg_catalog.strpos(notify_email, '@') > 1),
  created_by pg_catalog.uuid,
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  -- Exactly the fields owned by the selected kind.
  check (
    (kind = 'org_monthly_spend' and threshold_micro_usd is not null
       and budget_id is null and threshold_fraction is null) or
    (kind = 'budget_fraction' and budget_id is not null
       and threshold_fraction is not null and threshold_micro_usd is null)
  )
);

-- One rule per distinct trigger: several thresholds on one org/budget are
-- legitimate (50% then 90%), duplicates of the same threshold are not.
create unique index gateway_spend_alerts_rule_uniq
  on public.gateway_spend_alerts (
    org_id, kind,
    coalesce(budget_id, ''),
    coalesce(threshold_micro_usd, -1),
    coalesce(threshold_fraction, -1)
  );

comment on table public.gateway_spend_alerts is
  'Soft spend notifications (email), the warning counterpart to hard budgets/caps: org monthly spend threshold or fraction-of-budget consumed. Evaluated by gateway_spend_alerts_due() on the pg_cron tick; measurement reuses gateway_budget_scope_spent so alerts never disagree with the gates.';

create table public.gateway_spend_alert_events (
  alert_id  pg_catalog.text not null
    references public.gateway_spend_alerts(alert_id) on delete cascade,
  period    pg_catalog.text not null
    check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fired_at  pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  measured_micro_usd pg_catalog.int8 not null check (measured_micro_usd >= 0),
  threshold_micro_usd pg_catalog.int8 not null check (threshold_micro_usd >= 0),
  delivered_at pg_catalog.timestamptz,
  delivery_error pg_catalog.text,
  -- Delivery lease: overlapping ticks must not both send one claim. due()
  -- returns a row only when no live lease holds it and stamps a fresh one; a
  -- failed mark clears it (immediate retry next tick), a crashed deliverer's
  -- lease simply expires.
  claim_expires_at pg_catalog.timestamptz,
  -- Once per alert per month: the claim row IS the dedupe.
  primary key (alert_id, period)
);

comment on table public.gateway_spend_alert_events is
  'Fired-alert ledger and delivery state: the (alert, month) claim row dedupes firing; delivered_at null means an email is still owed (delivery is leased via claim_expires_at so overlapping ticks never double-send; delivery_error keeps the last failure).';

alter table public.gateway_spend_alerts enable row level security;
alter table public.gateway_spend_alert_events enable row level security;
revoke all on table public.gateway_spend_alerts
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_spend_alert_events
  from public, anon, authenticated, service_role;
-- The management API CRUDs rules and reads fired history as service_role;
-- events are WRITTEN only by the definer RPCs below.
grant select, insert, update, delete on table public.gateway_spend_alerts
  to service_role;
grant select on table public.gateway_spend_alert_events to service_role;

-- ---------------------------------------------------------------------------
-- Claim + read seam for the delivery route. Atomically inserts the claim row
-- for every rule whose measure crossed its threshold this UTC month, then
-- LEASES and returns the undelivered claims (fresh and previously-failed)
-- with the context the email needs. Concurrent ticks race on the primary key
-- for firing (the loser's insert no-ops) and on the delivery lease for
-- sending: a row already leased to a live tick is returned to nobody else,
-- so one claim gets at most one concurrent sender. gateway_spend_alert_mark
-- retires a delivered row or clears the lease on failure; a crashed
-- deliverer's lease expires on its own.

create function public.gateway_spend_alerts_due()
returns table (
  alert_id pg_catalog.text,
  period pg_catalog.text,
  kind pg_catalog.text,
  org_id pg_catalog.uuid,
  org_name pg_catalog.text,
  notify_email pg_catalog.text,
  budget_id pg_catalog.text,
  budget_scope_kind pg_catalog.text,
  measured_micro_usd pg_catalog.int8,
  threshold_micro_usd pg_catalog.int8,
  limit_micro_usd pg_catalog.int8,
  fired_at pg_catalog.timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_utc_now pg_catalog.timestamp;
  v_month_floor pg_catalog.timestamp;
  v_period pg_catalog.text;
  v_month_start pg_catalog.timestamptz;
  v_next_month pg_catalog.timestamptz;
  v_rule record;
  v_measured pg_catalog.int8;
  v_threshold pg_catalog.int8;
begin
  perform public.gateway_require_service_role();
  v_utc_now := pg_catalog.clock_timestamp() at time zone 'UTC';
  v_month_floor := pg_catalog.date_trunc('month', v_utc_now);
  v_period := pg_catalog.to_char(v_month_floor, 'YYYY-MM');
  v_month_start := v_month_floor at time zone 'UTC';
  v_next_month := (v_month_floor + pg_catalog.interval '1 month') at time zone 'UTC';

  for v_rule in
    select alerts.alert_id, alerts.org_id, alerts.kind,
           alerts.threshold_micro_usd, alerts.threshold_fraction,
           budgets.budget_id, budgets.scope_kind, budgets.api_key_id,
           budgets.identity_id, budgets.alias_id, budgets.pool_id,
           budgets.deployment_id, budgets.limit_micro_usd, budgets.period
      from public.gateway_spend_alerts alerts
      left join public.gateway_budgets budgets
        on budgets.budget_id = alerts.budget_id
     where not exists (
       select 1 from public.gateway_spend_alert_events events
        where events.alert_id = alerts.alert_id
          and events.period = v_period)
  loop
    if v_rule.kind = 'org_monthly_spend' then
      v_measured := public.gateway_budget_scope_spent(
        v_rule.org_id, 'team', null, null, null, null, null,
        v_month_start, v_next_month);
      v_threshold := v_rule.threshold_micro_usd;
    else
      -- A budget row that does not govern the current month (pinned to
      -- another 'YYYY-MM') measures nothing this period; skip it.
      if v_rule.budget_id is null
         or v_rule.period not in (v_period, '*') then
        continue;
      end if;
      v_measured := public.gateway_budget_scope_spent(
        v_rule.org_id, v_rule.scope_kind, v_rule.api_key_id,
        v_rule.identity_id, v_rule.alias_id, v_rule.pool_id,
        v_rule.deployment_id, v_month_start, v_next_month);
      v_threshold := pg_catalog.ceil(
        v_rule.limit_micro_usd * v_rule.threshold_fraction)::pg_catalog.int8;
    end if;
    if v_measured >= v_threshold then
      -- Conflict target by constraint name: a column-list target is parsed as
      -- expressions, which plpgsql would try to substitute with the return
      -- table's alert_id/period variables (ambiguous-column error).
      insert into public.gateway_spend_alert_events (
        alert_id, period, measured_micro_usd, threshold_micro_usd
      ) values (v_rule.alert_id, v_period, v_measured, v_threshold)
      on conflict on constraint gateway_spend_alert_events_pkey do nothing;
    end if;
  end loop;

  -- Lease-then-return: take a 10-minute delivery lease on a BOUNDED batch of
  -- undelivered, unleased claims and return exactly the rows leased here.
  -- The 100-row cap keeps the whole batch's sequential email sending far
  -- inside the lease window (100 sends at seconds each vs 10 minutes), so a
  -- trailing claim's lease cannot expire while its own batch is still
  -- running; anything past the cap rides the next 15-minute tick, oldest
  -- first. skip locked lets an overlapping tick pass by rows this one is
  -- claiming instead of queueing on them.
  return query
    with candidates as (
      select events.alert_id, events.period
        from public.gateway_spend_alert_events events
       where events.delivered_at is null
         and (events.claim_expires_at is null
              or events.claim_expires_at < pg_catalog.clock_timestamp())
       order by events.fired_at, events.alert_id
       limit 100
         for update skip locked
    ),
    leased as (
      update public.gateway_spend_alert_events events
         set claim_expires_at =
               pg_catalog.clock_timestamp() + pg_catalog.interval '10 minutes'
        from candidates
       where events.alert_id = candidates.alert_id
         and events.period = candidates.period
      returning events.alert_id, events.period, events.measured_micro_usd,
                events.threshold_micro_usd, events.fired_at
    )
    select leased.alert_id, leased.period, alerts.kind, alerts.org_id,
           orgs.name, alerts.notify_email, alerts.budget_id,
           budgets.scope_kind, leased.measured_micro_usd,
           leased.threshold_micro_usd, budgets.limit_micro_usd,
           leased.fired_at
      from leased
      join public.gateway_spend_alerts alerts
        on alerts.alert_id = leased.alert_id
      join public.organizations orgs on orgs.id = alerts.org_id
      left join public.gateway_budgets budgets
        on budgets.budget_id = alerts.budget_id
     order by leased.fired_at, leased.alert_id;
end;
$$;

revoke all on function public.gateway_spend_alerts_due()
  from public, anon, authenticated;
grant execute on function public.gateway_spend_alerts_due() to service_role;

comment on function public.gateway_spend_alerts_due() is
  'Claim-and-read for the spend-alert delivery tick: inserts the once-per-month claim row for every crossed rule, then leases (claim_expires_at, 10 min) and returns the undelivered claims with email context. Race-safe twice over: the PK dedupes firing, the lease stops overlapping ticks from double-sending. Retired by gateway_spend_alert_mark.';

create function public.gateway_spend_alert_mark(
  p_alert_id pg_catalog.text,
  p_period pg_catalog.text,
  p_error pg_catalog.text
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  update public.gateway_spend_alert_events events
     set delivered_at = case when p_error is null
           then pg_catalog.clock_timestamp() else null end,
         delivery_error = p_error,
         -- A failed delivery clears its lease so the next tick retries
         -- immediately instead of waiting out the 10 minutes.
         claim_expires_at = case when p_error is null
           then events.claim_expires_at else null end
   where events.alert_id = p_alert_id
     and events.period = p_period;
end;
$$;

revoke all on function public.gateway_spend_alert_mark(
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_spend_alert_mark(
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) to service_role;

comment on function public.gateway_spend_alert_mark(
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) is
  'Delivery receipt for one claimed spend alert: null error stamps delivered_at (retires the row), non-null records the failure and clears the delivery lease so the next tick retries immediately.';

-- ---------------------------------------------------------------------------
-- Schedule: every 15 minutes, mirror of invoke_daily_summary. Reads the
-- target URL and bearer secret from Vault; with either absent it exits
-- silently (local dev safety -- alerts simply never fire). pg_net only queues
-- here; its worker sends after commit.

create or replace function public.invoke_spend_alerts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  alerts_url text;
  bearer_secret text;
begin
  select secrets.decrypted_secret into alerts_url
  from vault.decrypted_secrets secrets
  where secrets.name = 'spend_alerts_url';
  select secrets.decrypted_secret into bearer_secret
  from vault.decrypted_secrets secrets
  where secrets.name = 'cron_secret';
  if alerts_url is null or bearer_secret is null then
    return;
  end if;
  perform net.http_post(
    url := alerts_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || bearer_secret
    )
  );
end;
$$;

revoke all on function public.invoke_spend_alerts()
  from public, anon, authenticated;

do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; gateway-spend-alerts schedule not attached';
    return;
  end if;
  -- cron.schedule upserts by job name, so re-running this migration (or a
  -- redeploy) never duplicates the job.
  perform cron.schedule(
    'gateway-spend-alerts',
    '*/15 * * * *',
    'select public.invoke_spend_alerts()'
  );
end;
$$;
