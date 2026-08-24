-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Per-promotion FUNDING SCOPE: a promotion targets all traffic, only
-- platform-funded (host_managed) traffic, or only BYOK (customer_managed).
-- Default 'platform_funded' preserves today's behavior exactly:
-- gateway_promo_state is invoked ONLY from the host_managed branch of
-- gateway_start_attempt, so promotions already only ever affected
-- platform-funded charges. This column makes that explicit and settable.
--
-- Enforcement: one predicate in gateway_promo_state's candidate filter
-- (funding_scope in ('all','platform_funded')). Since the function only runs on
-- the host_managed path, 'platform_funded' and 'all' both match as before, and
-- 'byok' is filtered out here (it would otherwise wrongly discount
-- platform-funded traffic). BYOK attempts are not charged platform credits and
-- never evaluate promotions, so a 'byok'-scoped promo is inert until BYOK
-- carries a platform charge; the admin UI documents this.

alter table public.model_promotions
  add column funding_scope pg_catalog.text not null default 'platform_funded'
    check (funding_scope in ('all', 'platform_funded', 'byok'));

comment on column public.model_promotions.funding_scope is
  'Money lane the promotion applies to: all | platform_funded (host_managed; default and prior behavior) | byok (customer_managed). Enforced by gateway_promo_state; BYOK carries no platform charge, so a byok-scoped promo is inert until BYOK is charged.';

-- Redefine gateway_promo_state (identical to 20260831000000 plus the one
-- funding_scope predicate). Same signature, so drop the current form first.
drop function public.gateway_promo_state(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int8
);

create function public.gateway_promo_state(
  p_org_id pg_catalog.uuid,
  p_model_slug pg_catalog.text,
  p_provider pg_catalog.text,
  p_worst_case_micro_usd pg_catalog.int8
)
returns table (
  is_promo pg_catalog.bool,
  promo_id pg_catalog.uuid,
  cap_micro_usd pg_catalog.int8,
  promo_spent_micro_usd pg_catalog.int8,
  within_cap pg_catalog.bool,
  cap_scope pg_catalog.text,
  period_key pg_catalog.text,
  notified pg_catalog.bool,
  percent_off pg_catalog.numeric,
  has_free_tier pg_catalog.bool,
  discount_cap_micro_usd pg_catalog.int8,
  discounted_spent_micro_usd pg_catalog.int8,
  discount_active pg_catalog.bool
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_candidate public.model_promotions%rowtype;
  v_month_floor pg_catalog.timestamp;
  v_month_start pg_catalog.timestamptz;
  v_next_month pg_catalog.timestamptz;
  v_period_key pg_catalog.text;
  v_free_spent pg_catalog.int8;
  v_disc_spent pg_catalog.int8;
  v_notified pg_catalog.bool;
  v_within_free pg_catalog.bool;
  v_disc_worst pg_catalog.int8;
  v_disc_active pg_catalog.bool;
  v_tier pg_catalog.int4;
  -- Best candidate so far, by tier: 1 = usable free tier (customer-best),
  -- 2 = usable discount, 3 = free-tier-bearing but exhausted (keeps the
  -- P1030/P1031 transitions firing), 4 = any match (its exhausted-discount
  -- state still shapes messages). 5 = nothing matched.
  v_best_tier pg_catalog.int4 := 5;
  v_best_id pg_catalog.uuid;
  v_best_cap pg_catalog.int8;
  v_best_free_spent pg_catalog.int8;
  v_best_within pg_catalog.bool;
  v_best_scope pg_catalog.text;
  v_best_period pg_catalog.text;
  v_best_notified pg_catalog.bool;
  v_best_percent pg_catalog.numeric;
  v_best_disc_cap pg_catalog.int8;
  v_best_disc_spent pg_catalog.int8;
  v_best_disc_active pg_catalog.bool;
begin
  v_month_floor := pg_catalog.date_trunc(
    'month', pg_catalog.clock_timestamp() at time zone 'UTC'
  );
  v_month_start := v_month_floor at time zone 'UTC';
  v_next_month := (v_month_floor + pg_catalog.interval '1 month') at time zone 'UTC';

  -- ONE pass over the matching candidates (deterministic order:
  -- display_order, then id), computing each candidate's per-org state exactly
  -- once -- this runs under the organizations money lock, so the aggregate
  -- scans must not repeat per priority tier. Model scope: explicit membership
  -- or the deliberate covers_all_models flag; empty membership without the
  -- flag (a cascade-emptied scope) matches nothing. Lane scope: empty = any
  -- provider. Audience scope: empty = every account, otherwise the org must
  -- carry EVERY required org_label.
  for v_candidate in
    select promotions.*
      from public.model_promotions promotions
     where promotions.active
       and (
         pg_catalog.cardinality(promotions.providers) = 0
         or (p_provider is not null
             and p_provider = any(promotions.providers))
       )
       and (
         promotions.covers_all_models
         or exists (
           select 1 from public.model_promotion_models membership
            where membership.promotion_id = promotions.id
              and membership.slug = p_model_slug
         )
       )
       and (
         pg_catalog.cardinality(promotions.audience_labels) = 0
         or not exists (
           select 1 from pg_catalog.unnest(promotions.audience_labels) req(key)
            where not exists (
              select 1 from public.org_labels l
               where l.org_id = p_org_id and l.key = req.key
            )
         )
       )
       -- Funding scope: this function runs ONLY on the host_managed
       -- (platform-funded) money path, so a promotion applies here when
       -- scoped to all traffic or to platform-funded traffic. A 'byok'
       -- promotion is filtered out: it must not discount platform-funded
       -- charges, and BYOK attempts carry no platform charge to discount.
       and promotions.funding_scope in ('all', 'platform_funded')
     order by promotions.display_order, promotions.id
  loop
    v_period_key := case v_candidate.cap_scope
      when 'recurring' then pg_catalog.to_char(v_month_floor, 'YYYY-MM')
      else 'lifetime'
    end;

    -- Free spend: promo-funded attempts of this (org, promotion), dispatched
    -- at their reservation, terminal at their settled cost. Recurring
    -- restricts to the current UTC month.
    select coalesce(pg_catalog.sum(
        case when attempts.state = 'dispatched'
          then attempts.promo_reserved_micro_usd
          else coalesce(attempts.promo_settled_micro_usd, 0)
        end), 0)
      into v_free_spent
      from public.gateway_attempts attempts
     where attempts.org_id = p_org_id
       and attempts.promo_id = v_candidate.id
       and attempts.promo_funded
       and (
         v_candidate.cap_scope <> 'recurring'
         or (attempts.budget_period_start >= v_month_start
             and attempts.budget_period_start < v_next_month)
       );

    -- Discounted CHARGED spend: credit-funded attempts this promotion
    -- discounted, at their (already discounted) reservation or settlement.
    select coalesce(pg_catalog.sum(
        case when attempts.state = 'dispatched'
          then attempts.budget_reserved_micro_usd
          else coalesce(attempts.budget_settled_micro_usd, 0)
        end), 0)
      into v_disc_spent
      from public.gateway_attempts attempts
     where attempts.org_id = p_org_id
       and attempts.promo_id = v_candidate.id
       and not attempts.promo_funded
       and attempts.promo_discount_percent > 0
       and (
         v_candidate.cap_scope <> 'recurring'
         or (attempts.budget_period_start >= v_month_start
             and attempts.budget_period_start < v_next_month)
       );

    select exists (
      select 1 from public.model_promotion_notices notices
       where notices.org_id = p_org_id
         and notices.promotion_id = v_candidate.id
         and notices.period_key = v_period_key
    ) into v_notified;

    v_within_free := p_worst_case_micro_usd is not null
      and v_free_spent + p_worst_case_micro_usd
            <= v_candidate.per_org_cap_micro_usd;

    -- The discount stays active while THIS request's discounted worst case
    -- still fits under the charged-spend ceiling (conservative: the boundary
    -- request pays list price rather than overshooting). Cap 0 = never
    -- expires.
    v_disc_worst := case
      when p_worst_case_micro_usd is null then null
      else pg_catalog.round(
        p_worst_case_micro_usd::pg_catalog.numeric
        * (100 - v_candidate.percent_off) / 100
      )::pg_catalog.int8
    end;
    v_disc_active := v_candidate.percent_off > 0 and (
      v_candidate.discount_cap_micro_usd = 0
      or (v_disc_worst is not null
          and v_disc_spent + v_disc_worst <= v_candidate.discount_cap_micro_usd)
    );

    v_tier := case
      when v_candidate.per_org_cap_micro_usd > 0
           and v_within_free and not v_notified then 1
      when v_disc_active then 2
      when v_candidate.per_org_cap_micro_usd > 0 then 3
      else 4
    end;
    if v_tier < v_best_tier then
      v_best_tier := v_tier;
      v_best_id := v_candidate.id;
      v_best_cap := v_candidate.per_org_cap_micro_usd;
      v_best_free_spent := v_free_spent;
      v_best_within := v_within_free;
      v_best_scope := v_candidate.cap_scope;
      v_best_period := v_period_key;
      v_best_notified := v_notified;
      v_best_percent := v_candidate.percent_off;
      v_best_disc_cap := v_candidate.discount_cap_micro_usd;
      v_best_disc_spent := v_disc_spent;
      v_best_disc_active := v_disc_active;
    end if;
    exit when v_best_tier = 1;
  end loop;

  if v_best_tier = 5 then
    -- No active promotion matches this (model, provider, audience).
    return query select
      false, null::pg_catalog.uuid, null::pg_catalog.int8, 0::pg_catalog.int8,
      false, null::pg_catalog.text, null::pg_catalog.text, false,
      0::pg_catalog.numeric, false,
      0::pg_catalog.int8, 0::pg_catalog.int8, false;
    return;
  end if;

  return query select
    true, v_best_id, v_best_cap, v_best_free_spent, v_best_within,
    v_best_scope, v_best_period, v_best_notified, v_best_percent,
    v_best_cap > 0, v_best_disc_cap, v_best_disc_spent, v_best_disc_active;
end;
$$;

revoke all on function public.gateway_promo_state(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated, service_role;

comment on function public.gateway_promo_state(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int8
) is
  'Winning promotion state for one (org, requested slug, attempt provider, worst case): both cap states (free allowance and charged-discount ceiling), scope window, and the one-time notice flag. Candidates are filtered by model scope, lane scope, and audience (empty audience = every account, else the org must carry every required org_label). A usable free tier beats a usable discount; with neither usable the free-tier-bearing candidate is reported so the P1030/P1031 transitions keep firing. Reservation-aware under the organizations row lock.';


-- ---------------------------------------------------------------------------
-- model_promotion_apply: add p_funding_scope, threaded into the insert and the
-- update (coalesced to 'platform_funded' to preserve behavior). The arg list is
-- the function's identity, so drop the current 12-arg form first.

drop function public.model_promotion_apply(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text[], pg_catalog.text[],
  pg_catalog.text[], pg_catalog.int8, pg_catalog.int8, pg_catalog.text,
  pg_catalog.numeric, pg_catalog.bool, pg_catalog.int4, pg_catalog.jsonb
);

create function public.model_promotion_apply(
  p_promotion_id pg_catalog.uuid,
  p_label pg_catalog.text,
  p_providers pg_catalog.text[],
  p_family_keys pg_catalog.text[],
  p_audience_labels pg_catalog.text[],
  p_per_org_cap_micro_usd pg_catalog.int8,
  p_discount_cap_micro_usd pg_catalog.int8,
  p_cap_scope pg_catalog.text,
  p_percent_off pg_catalog.numeric,
  p_active pg_catalog.bool,
  p_display_order pg_catalog.int4,
  p_members pg_catalog.jsonb,
  -- Added LAST with a DEFAULT so the prior 12-argument call (from API pods not
  -- yet rolled) still resolves during a rolling deploy: Postgres fills the
  -- default and PostgREST resolves the single remaining function by name.
  p_funding_scope pg_catalog.text default 'platform_funded'
)
returns table (promotion_id pg_catalog.uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id pg_catalog.uuid;
begin
  perform public.gateway_require_service_role();
  if p_promotion_id is null then
    insert into public.model_promotions (
      label, providers, family_keys, audience_labels, funding_scope,
      per_org_cap_micro_usd,
      discount_cap_micro_usd, cap_scope, percent_off, active, display_order,
      covers_all_models
    ) values (
      p_label, coalesce(p_providers, '{}'), coalesce(p_family_keys, '{}'),
      coalesce(p_audience_labels, '{}'),
      coalesce(p_funding_scope, 'platform_funded'),
      p_per_org_cap_micro_usd, p_discount_cap_micro_usd, p_cap_scope,
      p_percent_off, p_active, p_display_order,
      -- Explicit all-models intent: only an admin save with an empty model
      -- list (which the API admits only alongside a lane scope) sets this.
      pg_catalog.jsonb_array_length(coalesce(p_members, '[]'::pg_catalog.jsonb)) = 0
    ) returning id into v_id;
  else
    update public.model_promotions promotions
       set label = p_label,
           providers = coalesce(p_providers, '{}'),
           family_keys = coalesce(p_family_keys, '{}'),
           audience_labels = coalesce(p_audience_labels, '{}'),
           funding_scope = coalesce(p_funding_scope, 'platform_funded'),
           per_org_cap_micro_usd = p_per_org_cap_micro_usd,
           discount_cap_micro_usd = p_discount_cap_micro_usd,
           cap_scope = p_cap_scope,
           percent_off = p_percent_off,
           active = p_active,
           display_order = p_display_order,
           covers_all_models = pg_catalog.jsonb_array_length(
             coalesce(p_members, '[]'::pg_catalog.jsonb)) = 0,
           updated_at = pg_catalog.clock_timestamp()
     where promotions.id = p_promotion_id
     returning promotions.id into v_id;
    if v_id is null then
      raise exception using errcode = 'P0002',
        message = 'promotion does not exist';
    end if;
    delete from public.model_promotion_models members
     where members.promotion_id = v_id;
  end if;
  insert into public.model_promotion_models (promotion_id, model_id, slug)
  select v_id,
         (entry ->> 'model_id')::pg_catalog.uuid,
         entry ->> 'slug'
    from pg_catalog.jsonb_array_elements(coalesce(p_members, '[]'::pg_catalog.jsonb)) entry;
  return query select v_id;
end;
$$;

revoke all on function public.model_promotion_apply(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text[], pg_catalog.text[],
  pg_catalog.text[], pg_catalog.int8, pg_catalog.int8, pg_catalog.text,
  pg_catalog.numeric, pg_catalog.bool, pg_catalog.int4, pg_catalog.jsonb,
  pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.model_promotion_apply(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text[], pg_catalog.text[],
  pg_catalog.text[], pg_catalog.int8, pg_catalog.int8, pg_catalog.text,
  pg_catalog.numeric, pg_catalog.bool, pg_catalog.int4, pg_catalog.jsonb,
  pg_catalog.text
) to service_role;
