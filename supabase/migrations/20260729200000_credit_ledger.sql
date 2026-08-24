-- Real prepaid credits replace the usage-limit budget (D-METERING Credits v1,
-- superseded by the billing decision of 2026-07-29: a ledger, not a derived
-- limit, because top-ups/promo grants/adjustments need an auditable record).
--
-- Shape:
--   credit_ledger                       append-only credit-side entries
--                                       (grants, top-ups, adjustments)
--   organizations.credit_granted_usd    trigger-maintained sum of the ledger
--   organizations.billable_spend_usd    trigger-maintained priced spend that
--                                       draws down credits (= spend_usd minus
--                                       BYOK serving traffic, which the org
--                                       already pays its own provider for)
--   balance = credit_granted_usd - billable_spend_usd
--
-- spend_usd keeps its meaning (ALL priced usage, the meter the usage pages
-- show); billable_spend_usd is the half that costs the platform money. Both
-- stay one-row reads for the pre-spend gate. usage_limit_usd is dropped: its
-- job (refuse at $X) is now "balance reaches $0", its headroom is migrated
-- into an opening grant, and its admin editor becomes an admin credit grant.
--
-- BYOK attribution: serving_requests gains provider_connection_id (which org
-- connection served the call, for the customer's own declared-balance
-- drawdown) and a frozen `byok` boolean the spend triggers use. The boolean
-- is deliberately denormalized: the FK nulls out when a connection is
-- disconnected, and the delete leg of the spend trigger must reverse exactly
-- what the insert leg applied, connection row or not.

-- ---------------------------------------------------------------------------
-- 1. The ledger.

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  entry_type text not null check (entry_type in ('grant', 'topup', 'adjustment')),
  -- Grants and top-ups add credit; only adjustments (admin corrections,
  -- data-wipe compensation) may be negative. Zero entries are noise.
  -- Finite and non-zero: Postgres numeric admits NaN/Infinity, NaN compares
  -- ABOVE every value (so `> 0` passes it), and a NaN amount would poison the
  -- granted counter forever.
  amount_usd numeric(14, 6) not null
    check (amount_usd <> 0 and amount_usd > '-Infinity' and amount_usd < 'Infinity'),
  reason text,
  source text not null check (
    source in ('signup_promo', 'migration', 'admin', 'stripe')
  ),
  -- External idempotency handle (a Stripe checkout session id); unique per
  -- source so a replayed webhook cannot credit twice.
  source_ref text,
  created_by text,
  created_at timestamptz not null default now(),
  check (entry_type = 'adjustment' or amount_usd > 0)
);

create index credit_ledger_org_created_idx
  on public.credit_ledger (org_id, created_at desc);

create unique index credit_ledger_source_ref_key
  on public.credit_ledger (source, source_ref)
  where source_ref is not null;

comment on table public.credit_ledger is
  'Append-only credit-side entries per organization. Balance = organizations.credit_granted_usd - organizations.billable_spend_usd. Writes are service-role only; mutation is blocked by trigger.';

alter table public.credit_ledger enable row level security;

-- Members read their org''s history (the Settings usage page); every write
-- path is service-role (signup trigger, admin grants, Stripe webhook,
-- data-wipe compensation). No insert/update/delete policies on purpose.
create policy credit_ledger_select_member
  on public.credit_ledger
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- Append-only for everyone including the service role. The one legitimate
-- delete is the org-deletion cascade, recognizable because the parent row is
-- already gone when the cascade reaches the child.
create function public.credit_ledger_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.organizations orgs where orgs.id = old.org_id
  ) then
    return old;
  end if;
  raise exception 'credit_ledger is append-only; record a compensating adjustment instead';
end;
$$;

create trigger credit_ledger_append_only
before update or delete on public.credit_ledger
for each row execute function public.credit_ledger_block_mutation();

-- ---------------------------------------------------------------------------
-- 2. Counters on organizations (one-row reads for gate and gauges).

alter table public.organizations
  add column credit_granted_usd numeric(14, 6) not null default 0,
  add column billable_spend_usd numeric(14, 6) not null default 0;

comment on column public.organizations.credit_granted_usd is
  'Running sum of credit_ledger.amount_usd; maintained by trigger. Repair with recompute_org_credit(org_id).';
comment on column public.organizations.billable_spend_usd is
  'Priced spend that draws down credits: spend_usd minus BYOK serving traffic. Maintained by the same triggers as spend_usd; repair with recompute_org_spend(org_id).';

create function public.track_credit_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.organizations
     set credit_granted_usd = credit_granted_usd + new.amount_usd
   where id = new.org_id;
  return null;
end;
$$;

create trigger track_credit_ledger_entry
after insert on public.credit_ledger
for each row execute function public.track_credit_ledger_entry();

create function public.recompute_org_credit(target_org uuid)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  total numeric;
begin
  select coalesce(sum(ledger.amount_usd), 0)
    into total
    from public.credit_ledger ledger
   where ledger.org_id = target_org;
  update public.organizations set credit_granted_usd = total where id = target_org;
  return total;
end;
$$;

revoke all on function public.recompute_org_credit(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Billable spend rides the existing spend machinery — but deletes never
--    refund it.
--
-- Every non-serving metered surface (sessions, rollouts, builds, and the
-- frozen agent-era tables) is platform-paid, so the shared delta helper bumps
-- both counters. DELETES are different: `spend_usd` mirrors the scan-based
-- usage rollup (a deleted row leaves the scan), but `billable_spend_usd` is
-- money actually spent, and deleting the record of spending must never hand
-- credits back — an org admin deleting a world model (or wiping the org)
-- would otherwise refund the whole build bill and mint unlimited free spend.
-- So every trigger''s DELETE leg moves the spend METER only; UPDATE legs stay
-- symmetric on both counters (a corrected price is a correction, not a
-- deletion). Serving additionally applies the meter-only variant for BYOK
-- rows in every direction.

create or replace function public.apply_org_spend_delta(target_org uuid, delta numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_org is not null and delta is not null and delta <> 0 then
    update public.organizations
       set spend_usd = spend_usd + delta,
           billable_spend_usd = billable_spend_usd + delta
     where id = target_org;
  end if;
end;
$$;

-- The spend METER only, never billable: BYOK serving rows (both directions)
-- and every trigger''s DELETE leg.
create function public.apply_org_unbillable_spend_delta(target_org uuid, delta numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_org is not null and delta is not null and delta <> 0 then
    update public.organizations
       set spend_usd = spend_usd + delta
     where id = target_org;
  end if;
end;
$$;

revoke all on function public.apply_org_unbillable_spend_delta(uuid, numeric)
  from public, anon, authenticated;

-- Redefine every pre-existing spend trigger''s DELETE leg to the meter-only
-- variant. Bodies otherwise identical to their original definitions
-- (20260709150000, 20260711030000, 20260711040000, 20260713210000).
create or replace function public.track_session_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform public.apply_org_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  elsif tg_op = 'DELETE' then
    perform public.apply_org_unbillable_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
  end if;
  return null;
end;
$$;

create or replace function public.track_rollout_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform public.apply_org_spend_delta(
      old.org_id, -(coalesce(old.cost_usd, 0) + coalesce(old.wm_cost_usd, 0)));
  elsif tg_op = 'DELETE' then
    perform public.apply_org_unbillable_spend_delta(
      old.org_id, -(coalesce(old.cost_usd, 0) + coalesce(old.wm_cost_usd, 0)));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(
      new.org_id, coalesce(new.cost_usd, 0) + coalesce(new.wm_cost_usd, 0));
  end if;
  return null;
end;
$$;

create or replace function public.track_build_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform public.apply_org_spend_delta(old.org_id, -public.build_usage_spend(old.usage));
  elsif tg_op = 'DELETE' then
    perform public.apply_org_unbillable_spend_delta(
      old.org_id, -public.build_usage_spend(old.usage));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, public.build_usage_spend(new.usage));
  end if;
  return null;
end;
$$;

create or replace function public.track_opt_run_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform public.apply_org_spend_delta(old.org_id, -public.opt_run_usage_spend(old.usage));
  elsif tg_op = 'DELETE' then
    perform public.apply_org_unbillable_spend_delta(
      old.org_id, -public.opt_run_usage_spend(old.usage));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, public.opt_run_usage_spend(new.usage));
  end if;
  return null;
end;
$$;

create or replace function public.track_cost_report_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform public.apply_org_spend_delta(old.org_id, -public.cost_report_usage_spend(old.usage));
  elsif tg_op = 'DELETE' then
    perform public.apply_org_unbillable_spend_delta(
      old.org_id, -public.cost_report_usage_spend(old.usage));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, public.cost_report_usage_spend(new.usage));
  end if;
  return null;
end;
$$;

create or replace function public.track_session_agent_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform public.apply_org_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  elsif tg_op = 'DELETE' then
    perform public.apply_org_unbillable_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
  end if;
  return null;
end;
$$;

create or replace function public.track_local_pi_run_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform public.apply_org_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  elsif tg_op = 'DELETE' then
    perform public.apply_org_unbillable_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. BYOK attribution on serving rows + the org-key drawdown counter.

alter table public.serving_requests
  add column provider_connection_id uuid
    references public.provider_connections(id) on delete set null,
  add column byok boolean not null default false;

comment on column public.serving_requests.provider_connection_id is
  'Org provider connection whose credential served this call (null = platform credentials). Drawdown attribution for the connection''s declared balance; nulls out if the connection is disconnected.';
comment on column public.serving_requests.byok is
  'Frozen at insert: the provider bill for this call went to the org''s own account, so it is metered in spend_usd but never draws down platform credits.';

alter table public.provider_connections
  add column declared_balance_usd numeric(14, 6)
    check (declared_balance_usd is null or declared_balance_usd >= 0),
  add column declared_balance_set_at timestamptz,
  add column metered_spend_usd numeric(14, 6) not null default 0,
  add column low_balance_threshold_usd numeric(14, 6) not null default 5
    check (low_balance_threshold_usd >= 0);

comment on column public.provider_connections.declared_balance_usd is
  'Customer-declared remaining credit on their provider account (we cannot read it from the provider). Null = not tracked. Remaining = declared_balance_usd - metered_spend_usd.';
comment on column public.provider_connections.metered_spend_usd is
  'Estimated spend metered through this connection since declared_balance_usd was last set; reset to 0 whenever the customer re-declares. List-priced estimate, not the provider''s invoice.';

create index serving_requests_provider_connection_idx
  on public.serving_requests (provider_connection_id)
  where provider_connection_id is not null;

create or replace function public.track_serving_request_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if old.byok or tg_op = 'DELETE' then
      -- BYOK never touched billable; a DELETE must not refund it either.
      perform public.apply_org_unbillable_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
    else
      perform public.apply_org_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
    end if;
    if old.provider_connection_id is not null then
      update public.provider_connections
         set metered_spend_usd = metered_spend_usd - coalesce(old.cost_usd, 0)
       where id = old.provider_connection_id;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if new.byok then
      perform public.apply_org_unbillable_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
    else
      perform public.apply_org_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
    end if;
    if new.provider_connection_id is not null then
      update public.provider_connections
         set metered_spend_usd = metered_spend_usd + coalesce(new.cost_usd, 0)
       where id = new.provider_connection_id;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists track_serving_request_spend on public.serving_requests;
create trigger track_serving_request_spend
after insert or update of org_id, cost_usd or delete on public.serving_requests
for each row execute function public.track_serving_request_spend();

-- ---------------------------------------------------------------------------
-- 5. New organizations start with a welcome grant instead of a $20 limit.

create function public.grant_signup_promo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source)
  values (new.id, 'grant', 20, 'Welcome credit', 'signup_promo');
  return null;
end;
$$;

create trigger organizations_signup_promo
after insert on public.organizations
for each row execute function public.grant_signup_promo();

-- ---------------------------------------------------------------------------
-- 6. Migrate existing organizations, then retire the limit.
--
-- billable history: BYOK starts existing with this migration, so everything
-- metered so far was platform-paid.
update public.organizations set billable_spend_usd = spend_usd;

-- Opening grant preserves each org''s current headroom exactly: balance
-- (= grant - spend) equals the old limit - spend, including a negative
-- balance for an org that had overshot its budget. Unlimited legacy orgs
-- (null limit: pre-limit-era, operator, and demo orgs) get their spend plus
-- $1000 of headroom; platform admins can grant more from the admin panel.
insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source, source_ref)
select
  orgs.id,
  'grant',
  coalesce(orgs.usage_limit_usd, orgs.spend_usd + 1000),
  'Opening balance migrated from the usage limit',
  'migration',
  'usage-limit:' || orgs.id
from public.organizations orgs
where coalesce(orgs.usage_limit_usd, orgs.spend_usd + 1000) > 0
  -- An org created inside the migration window (or a replayed apply) already
  -- holds ledger rows; never grant it a second opening balance.
  and not exists (
    select 1 from public.credit_ledger ledger where ledger.org_id = orgs.id
  );

-- usage_limit_usd is RETIRED, not yet dropped: an API rollback to the
-- pre-credit build would read a dropped column as "unlimited" and silently
-- turn spend enforcement off for every tenant. The column keeps its old
-- values (so rolled-back code enforces the old limits), loses its $20
-- default (new orgs are granted credits by trigger instead), and nothing in
-- the current build reads it. Drop it in a follow-up migration once the
-- rollback window has closed.
alter table public.organizations alter column usage_limit_usd drop default;
comment on column public.organizations.usage_limit_usd is
  'RETIRED by the credit ledger (20260729200000): kept only so a rolled-back API build still enforces the old limits. No current reader. Drop after the rollback window.';

-- ---------------------------------------------------------------------------
-- 7. Repair path recomputes both counters (byok-aware serving term).

create or replace function public.recompute_org_spend(target_org uuid)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  shared numeric;
  serving_total numeric;
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
    into shared;
  select
      coalesce(sum(coalesce(serving.cost_usd, 0)), 0)
    into serving_total
    from public.serving_requests serving
   where serving.org_id = target_org;
  -- billable_spend_usd is deliberately NOT recomputed: deletes keep it (money
  -- stays spent when its rows are wiped), so the surviving rows are a floor,
  -- not the truth, and a recompute would silently re-issue every historical
  -- refund. Repair billable through an auditable admin ledger adjustment.
  update public.organizations
     set spend_usd = shared + serving_total
   where id = target_org;
  return shared + serving_total;
end;
$$;

-- Connection drawdown repair: re-sum the rows still attributed to the
-- connection. Only meaningful while declared_balance_set_at predates the
-- surviving rows; the caller re-declares after big deletions anyway.
create function public.recompute_provider_connection_spend(target_connection uuid)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  total numeric;
begin
  select coalesce(sum(coalesce(requests.cost_usd, 0)), 0)
    into total
    from public.serving_requests requests
   where requests.provider_connection_id = target_connection
     and requests.created_at >= coalesce((
       select connections.declared_balance_set_at
         from public.provider_connections connections
        where connections.id = target_connection), '-infinity'::timestamptz);
  update public.provider_connections
     set metered_spend_usd = total
   where id = target_connection;
  return total;
end;
$$;

revoke all on function public.recompute_provider_connection_spend(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Window stats learn to see declared-zero-price traffic.
--
-- A $0-priced row (a customer''s local model, a free arm) is a real zero,
-- not an unpriced null, so the savings read must be able to exclude it from
-- a frontier comparison instead of claiming the whole baseline as saved.
-- Return type changes, so drop + recreate.

drop function if exists public.serving_request_stats(uuid, uuid, timestamptz, timestamptz);

create function public.serving_request_stats(
  in_org uuid,
  in_endpoint uuid default null,
  in_after timestamptz default null,
  in_before timestamptz default null
)
returns table (
  request_count bigint,
  error_count bigint,
  -- Rows with no verified price: surfaced so a spend total over a partially
  -- priced window never silently under-reports (house cost honesty rule).
  unpriced_count bigint,
  cost_usd_total numeric,
  input_tokens_total bigint,
  output_tokens_total bigint,
  cached_tokens_total bigint,
  -- Rows priced at a true $0 (customer-declared free models): counted and
  -- token-summed separately so savings math can leave them out of both sides
  -- of a frontier comparison.
  zero_cost_count bigint,
  zero_cost_input_tokens bigint,
  zero_cost_output_tokens bigint,
  zero_cost_cached_tokens bigint,
  latency_p50_ms double precision,
  latency_p95_ms double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select
    count(*),
    count(*) filter (where requests.status = 'error'),
    count(*) filter (where requests.cost_usd is null),
    sum(requests.cost_usd),
    coalesce(sum(requests.input_tokens), 0)::bigint,
    coalesce(sum(requests.output_tokens), 0)::bigint,
    coalesce(sum(requests.cached_tokens), 0)::bigint,
    count(*) filter (where requests.cost_usd = 0),
    coalesce(sum(requests.input_tokens) filter (where requests.cost_usd = 0), 0)::bigint,
    coalesce(sum(requests.output_tokens) filter (where requests.cost_usd = 0), 0)::bigint,
    coalesce(sum(requests.cached_tokens) filter (where requests.cost_usd = 0), 0)::bigint,
    percentile_cont(0.5) within group (order by requests.latency_ms),
    percentile_cont(0.95) within group (order by requests.latency_ms)
    from public.serving_requests requests
   where requests.org_id = in_org
     and (in_endpoint is null or requests.endpoint_id = in_endpoint)
     and (in_after is null or requests.created_at >= in_after)
     and (in_before is null or requests.created_at < in_before);
end;
$$;

revoke all on function public.serving_request_stats(
  uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.serving_request_stats(
  uuid, uuid, timestamptz, timestamptz
) to service_role;
