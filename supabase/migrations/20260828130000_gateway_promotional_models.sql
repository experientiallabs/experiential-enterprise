-- ---------------------------------------------------------------------------
-- Promotional (free) models with a silent per-(org, model) usage cap, plus a
-- pre-verify credit-spend allowance (the product owner, 2026-08-28).
--
-- Two composable additions to the host-lane reservation seam, both living
-- alongside the existing money guards in gateway_start_attempt (never rewriting
-- them):
--
-- 1. PROMOTIONAL MODELS. public.model_promotions lists catalog models the
--    platform funds for FREE up to a per-org dollar cap, tracked SEPARATELY from
--    the org's credits. While an org is under the cap for a promo model, its
--    usage is promo-funded: it draws no credits (the attempt reserves/settles in
--    the promo_* columns, budget_* stay 0, so every credit/budget/cap read --
--    all of which sum budget_* -- sees the attempt as $0). The cap is per-org
--    LIFETIME by default; a single cap_scope flag switches a model to per-org
--    RECURRING (monthly, UTC).
--
--    A promotion carries BOTH a free cap AND a percent discount, and admins
--    manage all of it (add/remove models, set the cap, set % off, active,
--    display_order) via the platform-admin panel over public.model_promotions.
--
--    CAP vs PERCENT_OFF semantics (both composable on one promo):
--      * per_org_cap_micro_usd > 0 defines a FREE tier: within the cap, usage is
--        100% free (percent_off is implied 100 here) and draws no credits.
--      * percent_off (0-100) is a straight discount on the org's CREDIT charge
--        AFTER the free cap is reached, or from the FIRST request when the cap
--        is 0 (a pure-discount promo with no free tier). The charged amount =
--        full cost * (1 - percent_off/100), applied to both the reserve-time
--        worst case (so every credit/budget/cap gate sees the discounted figure)
--        and the settled cost. percent_off does NOT bypass the credit balance
--        gate: a 100%-off post-cap charge is still refused on a zero balance.
--
--    State machine at the reservation seam, per (org, promo model):
--      * UNDER CAP (cap>0) -> promo-funded (free). No credit draw.          (2)
--      * CAP REACHED (cap>0), org not yet notified -> P1030
--        promo_exhausted_notice: a one-time refusal (429) telling the user the
--        free promo is used up and further use now draws org credits (at the %
--        off, if any). The notice is made ONE-TIME by a committed
--        model_promotion_notices row the ledger writes in a separate transaction
--        after catching P1030 (a plpgsql `raise` rolls its own tx back).     (3a)
--      * CAP REACHED, notified -> credits path at (1 - percent_off).        (3b)
--      * Pure-discount promo (cap=0) -> credits path at (1 - percent_off) from
--        the first request; there is no free->credits switch, so NO P1030.
--      * credits cannot cover the (discounted) charge -> P1031 promo_byok_only:
--        the platform stops serving the model on the house lane; it is BYOK-only
--        for that org and reads as a clean 429.                             (3c)
--    P1030/P1031 are team-scope (they STOP routing and 429, never advance the
--    waterfall to another rung of the same model), mapped in the P2 ledger.
--
-- 2. PRE-VERIFY SPEND ALLOWANCE. Today the P1025 gate blocks ALL platform-credit
--    spend for an org whose founding admin has not proven inbox ownership
--    (organizations.spend_unlocked_at is null). This relaxes it to a cumulative
--    allowance: an unverified org may accrue up to app_settings
--    .pre_verify_allowance_micro_usd (default $1) of charged-or-reserved credit
--    spend, then P1025 blocks the rest until they verify. Allowance 0 == today's
--    behavior (block all unverified credit spend). Promo-free spend never counts
--    (promo attempts hold 0 in budget_*). The allowance column is owned by the
--    credits/admin agent; this migration READS it through a guarded helper so it
--    is self-contained if it lands first.
--
-- Catalog coordination: the catalog agent READS public.model_promotions
-- (active + display_order, joined to public.models) to render the Promotional
-- section; it never writes it and owns none of the enforcement here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Source-of-truth config: which catalog models are promotional, their
--    per-org cap, and the cap scope. One row per catalog model.
--
-- ORDER-INDEPENDENT with the catalog agent's PR (#673), which also creates this
-- table idempotently with the DISPLAY columns (model_id, slug, active,
-- display_order) and seeds the promo slugs as display placeholders. Whichever
-- migration applies first CREATES the table; the other only ADDS its missing
-- columns. This migration owns the CAP columns (per_org_cap_micro_usd,
-- cap_scope); the catalog PR owns the display columns. Neither create-collides
-- (create-if-not-exists) and neither duplicate-seeds (the seed upserts caps onto
-- the shared rows). `slug` is the shared enforcement/display key == models.slug.

create table if not exists public.model_promotions (
  id pg_catalog.uuid primary key default pg_catalog.gen_random_uuid(),
  -- The catalog model this promotion funds. FK guarantees it exists; the
  -- delete cascade retires the promotion with its model.
  model_id pg_catalog.uuid not null
    references public.models(id) on delete cascade,
  -- Public catalog slug (== models.slug); the gateway matches the request's
  -- requested alias (gateway_requests.alias, which is the catalog slug) against
  -- it without joining to models on every reservation. Shared with the catalog
  -- PR (its display column).
  slug pg_catalog.text not null,
  -- Per-org free allowance for this model, micro-USD. Default 0 = no free
  -- allowance until a cap is seeded, so a catalog display placeholder is safe
  -- (it simply funds nothing free until this migration's seed fills the cap).
  per_org_cap_micro_usd pg_catalog.int8 not null default 0
    check (per_org_cap_micro_usd >= 0),
  -- 'lifetime' (default): the cap never resets per org. 'recurring': the cap
  -- resets every UTC month. One flag flips a model between the two.
  cap_scope pg_catalog.text not null default 'lifetime'
    check (cap_scope in ('lifetime', 'recurring')),
  -- Straight percentage discount (0-100) applied to CREDIT spend on this model
  -- once the free cap is reached (or from the first request when the cap is 0).
  -- Within the free cap usage is always 100% free regardless of this value; see
  -- the cap-vs-percent_off semantics in the header.
  percent_off pg_catalog.numeric not null default 0
    check (percent_off >= 0 and percent_off <= 100),
  -- The catalog agent reads active + display_order to render the Promotional
  -- section (an inactive promotion stops both display and enforcement).
  active pg_catalog.bool not null default true,
  display_order pg_catalog.int4 not null default 0,
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  updated_at pg_catalog.timestamptz not null default pg_catalog.now()
);

-- Add the CAP/DISCOUNT columns when the catalog PR created the table first (its
-- definition has the display columns but not these). No-ops when this migration
-- created the table above. The inline checks match the create above.
alter table public.model_promotions
  add column if not exists per_org_cap_micro_usd pg_catalog.int8 not null default 0
    check (per_org_cap_micro_usd >= 0);
alter table public.model_promotions
  add column if not exists cap_scope pg_catalog.text not null default 'lifetime'
    check (cap_scope in ('lifetime', 'recurring'));
alter table public.model_promotions
  add column if not exists percent_off pg_catalog.numeric not null default 0
    check (percent_off >= 0 and percent_off <= 100);

comment on table public.model_promotions is
  'Source of truth for promotional (free) catalog models and their per-org dollar cap. Read by the catalog agent (active + display_order, joined to public.models via model_id/slug) for the Promotional section; enforced by gateway_start_attempt via the per-(org, slug) promo cap. cap_scope: lifetime (default) or recurring (monthly, UTC). Cap columns owned by the gateway workstream; display columns by the catalog workstream.';

grant select on public.model_promotions to authenticated;
grant select, insert, update, delete on public.model_promotions to service_role;

-- One promotion per catalog model and per slug (the enforcement key); the
-- gateway's cap upsert targets ON CONFLICT (slug). create-if-not-exists so the
-- indexes exist whichever migration created the table.
create unique index if not exists model_promotions_slug_key
  on public.model_promotions (slug);
create unique index if not exists model_promotions_model_id_key
  on public.model_promotions (model_id);
create index if not exists model_promotions_active_order_idx
  on public.model_promotions (display_order)
  where active;

-- ---------------------------------------------------------------------------
-- 2. One-time promo-exhaustion notice marker. Presence of a row means "this
--    org has been told the free promo for this model (in this period) is used
--    up", so the transition refusal (P1030) fires exactly once and later
--    requests fall through to the credits path. Written by the ledger in a
--    separate committed transaction (a `raise` in gateway_start_attempt rolls
--    its own work back, so the marker cannot be committed inside the refusing
--    call).

create table public.model_promotion_notices (
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  model_slug pg_catalog.text not null,
  -- 'lifetime' for a lifetime-scoped promotion, 'YYYY-MM' (UTC) for a recurring
  -- one, so a recurring promo re-notifies each month it is re-exhausted.
  period_key pg_catalog.text not null,
  notified_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (org_id, model_slug, period_key)
);

comment on table public.model_promotion_notices is
  'One row per (org, promo model, period) whose free-promo exhaustion has been surfaced to the user, making the P1030 promo->credits notice one-time. Written by the gateway ledger after a P1030 refusal.';

grant select, insert on public.model_promotion_notices to service_role;

-- ---------------------------------------------------------------------------
-- 3. Promo accounting columns on gateway_attempts. Promo-funded attempts hold
--    their worst-case/settled cost HERE and 0 in budget_*, so the existing
--    credit balance gate, daily caps, per-key cap, and per-scope budgets -- all
--    of which sum budget_* -- treat promo usage as $0 (never a credit draw),
--    while the promo cap reads the promo_* columns.

alter table public.gateway_attempts
  add column promo_funded pg_catalog.bool not null default false,
  add column promo_reserved_micro_usd pg_catalog.int8 not null default 0
    check (promo_reserved_micro_usd >= 0),
  add column promo_settled_micro_usd pg_catalog.int8
    check (promo_settled_micro_usd is null or promo_settled_micro_usd >= 0),
  -- Percent discount frozen at reserve time for a CREDIT-funded promo attempt
  -- (0 for free promo attempts, non-promo, and BYOK). budget_reserved already
  -- holds the discounted worst case; settlement applies the same percent to the
  -- actual cost so the charge and the reservation agree.
  add column promo_discount_percent pg_catalog.numeric not null default 0
    check (promo_discount_percent >= 0 and promo_discount_percent <= 100);

comment on column public.gateway_attempts.promo_funded is
  'True when this host-lane attempt was served free under a model_promotions cap: it draws NO org credits. Its worst-case/settled cost lives in promo_reserved_micro_usd/promo_settled_micro_usd and budget_* stay 0.';
comment on column public.gateway_attempts.promo_discount_percent is
  'Percent (0-100) discount applied to this CREDIT-funded promo attempt''s charge, frozen at reserve time. budget_reserved_micro_usd is already net of it; settlement discounts the actual cost by the same percent. 0 for free promo attempts, non-promo, and BYOK.';

-- The promo-cap sum reads one org''s promo-funded attempts for one requested
-- alias (joined through gateway_requests), bounded by period for recurring.
create index gateway_attempts_promo_idx
  on public.gateway_attempts (org_id, budget_period_start)
  where promo_funded;

-- ---------------------------------------------------------------------------
-- 4. Guarded read of the pre-verify allowance. The column is owned by the
--    credits/admin agent (app_settings.pre_verify_allowance_micro_usd, default
--    1_000_000); read it if present, else fall back to $1 so this migration is
--    self-contained. Value 0 => block ALL unverified credit spend (today's
--    behavior).

create function public.gateway_pre_verify_allowance_micro_usd()
returns pg_catalog.int8
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_allowance pg_catalog.int8;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'app_settings'
       and column_name = 'pre_verify_allowance_micro_usd'
  ) then
    execute 'select pre_verify_allowance_micro_usd from public.app_settings '
      || 'where singleton limit 1'
      into v_allowance;
  end if;
  return pg_catalog.coalesce(v_allowance, 1000000);
end;
$$;

revoke all on function public.gateway_pre_verify_allowance_micro_usd()
  from public, anon, authenticated, service_role;

comment on function public.gateway_pre_verify_allowance_micro_usd() is
  'Cumulative micro-USD of platform-credit spend an unverified org may accrue before P1025 blocks. Reads app_settings.pre_verify_allowance_micro_usd when that column exists, else $1. 0 = block all unverified credit spend.';

-- ---------------------------------------------------------------------------
-- 5. Promo state for one (org, requested model, worst case). Returns whether
--    the model is promotional, the cap, the org''s charged-or-reserved promo
--    spend in the applicable window, whether the worst case still fits, the
--    scope/period, and whether the exhaustion notice has already been surfaced.
--    Reservation-aware like the caps: meaningful only under the organizations
--    row lock the caller already holds.

create function public.gateway_promo_state(
  p_org_id pg_catalog.uuid,
  p_model_slug pg_catalog.text,
  p_worst_case_micro_usd pg_catalog.int8
)
returns table (
  is_promo pg_catalog.bool,
  cap_micro_usd pg_catalog.int8,
  promo_spent_micro_usd pg_catalog.int8,
  within_cap pg_catalog.bool,
  cap_scope pg_catalog.text,
  period_key pg_catalog.text,
  notified pg_catalog.bool,
  -- Straight percent discount on the post-cap credit charge, and whether a free
  -- tier exists at all (cap > 0). has_free_tier=false is a pure-discount promo:
  -- no free phase, so no free->credits transition notice ever fires.
  percent_off pg_catalog.numeric,
  has_free_tier pg_catalog.bool
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_promo public.model_promotions%rowtype;
  v_month_floor pg_catalog.timestamp;
  v_month_start pg_catalog.timestamptz;
  v_next_month pg_catalog.timestamptz;
  v_period_key pg_catalog.text;
  v_spent pg_catalog.int8;
  v_notified pg_catalog.bool;
begin
  select promotions.* into v_promo
    from public.model_promotions promotions
   where promotions.slug = p_model_slug
     and promotions.active;
  -- Check the shared NOT NULL `slug` column (not `id`, which the catalog PR's
  -- table shape may not carry) to detect "no active promotion for this slug".
  if v_promo.slug is null then
    return query select
      false, null::pg_catalog.int8, 0::pg_catalog.int8, false,
      null::pg_catalog.text, null::pg_catalog.text, false,
      0::pg_catalog.numeric, false;
    return;
  end if;

  v_month_floor := pg_catalog.date_trunc(
    'month', pg_catalog.clock_timestamp() at time zone 'UTC'
  );
  v_month_start := v_month_floor at time zone 'UTC';
  v_next_month := (v_month_floor + pg_catalog.interval '1 month') at time zone 'UTC';
  v_period_key := case v_promo.cap_scope
    when 'recurring' then pg_catalog.to_char(v_month_floor, 'YYYY-MM')
    else 'lifetime'
  end;

  -- Charged-or-reserved promo spend for this (org, model): dispatched attempts
  -- at their promo reservation, terminal attempts at their settled promo cost.
  -- Recurring restricts to the current UTC month; lifetime spans all periods.
  select pg_catalog.coalesce(pg_catalog.sum(
      case when attempts.state = 'dispatched'
        then attempts.promo_reserved_micro_usd
        else pg_catalog.coalesce(attempts.promo_settled_micro_usd, 0)
      end), 0)
    into v_spent
    from public.gateway_attempts attempts
    join public.gateway_requests requests
      on requests.request_id = attempts.request_id
   where attempts.org_id = p_org_id
     and attempts.promo_funded
     and requests.alias = p_model_slug
     and (
       v_promo.cap_scope <> 'recurring'
       or (attempts.budget_period_start >= v_month_start
           and attempts.budget_period_start < v_next_month)
     );

  select exists (
    select 1 from public.model_promotion_notices notices
     where notices.org_id = p_org_id
       and notices.model_slug = p_model_slug
       and notices.period_key = v_period_key
  ) into v_notified;

  return query select
    true,
    v_promo.per_org_cap_micro_usd,
    v_spent,
    -- A null worst case (unknown price) cannot be bounded against the cap: not
    -- within it. host_managed callers never reach here with a null worst case
    -- (P1013 fires first), but keep the helper honest for any caller.
    p_worst_case_micro_usd is not null
      and v_spent + p_worst_case_micro_usd <= v_promo.per_org_cap_micro_usd,
    v_promo.cap_scope,
    v_period_key,
    v_notified,
    v_promo.percent_off,
    v_promo.per_org_cap_micro_usd > 0;
end;
$$;

revoke all on function public.gateway_promo_state(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated, service_role;

comment on function public.gateway_promo_state(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8
) is
  'Promo funding state for one (org, requested model slug, worst-case cost): is_promo, the cap, the org''s charged-or-reserved promo spend in the applicable window (lifetime or current UTC month), whether the worst case still fits, cap_scope, period_key, and whether the exhaustion notice was already surfaced. Reservation-aware under the organizations row lock.';

-- ---------------------------------------------------------------------------
-- 6. Mark a (org, promo model) exhaustion notice delivered. Idempotent upsert,
--    resolving the period_key from the promotion''s scope. Called by the ledger
--    in a fresh transaction after a P1030 refusal so the notice becomes
--    one-time (the refusing gateway_start_attempt call rolled its own tx back).

create function public.gateway_mark_promo_notified(
  p_org_id pg_catalog.uuid,
  p_model_slug pg_catalog.text
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope pg_catalog.text;
  v_period_key pg_catalog.text;
begin
  perform public.gateway_require_service_role();
  select promotions.cap_scope into v_scope
    from public.model_promotions promotions
   where promotions.slug = p_model_slug
     and promotions.active;
  if v_scope is null then
    -- Promotion was retired between the refusal and this write; nothing to mark.
    return;
  end if;
  v_period_key := case v_scope
    when 'recurring' then pg_catalog.to_char(
      pg_catalog.date_trunc('month', pg_catalog.clock_timestamp() at time zone 'UTC'),
      'YYYY-MM')
    else 'lifetime'
  end;
  insert into public.model_promotion_notices (org_id, model_slug, period_key)
  values (p_org_id, p_model_slug, v_period_key)
  on conflict (org_id, model_slug, period_key) do nothing;
end;
$$;

revoke all on function public.gateway_mark_promo_notified(
  pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_mark_promo_notified(
  pg_catalog.uuid, pg_catalog.text
) to service_role;

