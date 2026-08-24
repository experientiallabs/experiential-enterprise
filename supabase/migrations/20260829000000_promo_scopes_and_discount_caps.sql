-- Promotions v2: scoped promotions with a per-org discount cap.
--
-- v1 (20260828130000) keyed one promotion to one catalog model (unique slug /
-- model_id). v2 makes a promotion a first-class object with a SCOPE:
--   * model scope  -> explicit membership rows in model_promotion_models
--                     (empty membership = "all models");
--   * lane scope   -> providers text[] matched against the ATTEMPT's provider
--                     at reserve time ("50% off when served through
--                     Experiential Cloud"), empty = any provider;
--   * family_keys  -> display metadata only (the admin UI expands a family to
--                     concrete membership rows at save time; enforcement never
--                     reads it).
-- and adds a second, independent cap: discount_cap_micro_usd bounds the
-- per-org CHARGED (post-discount) spend that percent_off applies to. Within
-- the cap credit spend is discounted; past it the same models charge list
-- price. 0 = the discount never expires. The existing per_org_cap_micro_usd
-- keeps its v1 meaning (free allowance), now summed across the promotion's
-- whole scope rather than per model.
--
-- Enforcement stays where v1 put it: gateway_start_attempt (reserve) and
-- gateway_settle_attempt (charge) — settle is UNCHANGED (the frozen
-- promo_discount_percent already carries everything settlement needs). Spend
-- accounting keys on the new gateway_attempts.promo_id, so both caps are
-- reservation-aware sums over one indexed scan, exactly like v1's free cap.

-- ---------------------------------------------------------------------------
-- 1. Promotion identity + scope + discount cap.

alter table public.model_promotions
  add column label pg_catalog.text,
  -- Serving lanes the promotion applies to; empty = any lane. Must stay a
  -- subset of the catalog provider vocabulary (model_providers_provider_check
  -- in 20260819160000 + 20260826010000) — widen the two in lockstep.
  add column providers pg_catalog.text[] not null
    default '{}'::pg_catalog.text[],
  -- How the admin picked the model scope (family keys from the web catalog's
  -- family taxonomy). Display metadata only; membership rows are authoritative.
  add column family_keys pg_catalog.text[] not null
    default '{}'::pg_catalog.text[],
  -- Per-org ceiling on CHARGED (post-discount) spend the percent_off discount
  -- applies to, micro-USD. 0 = the discount never expires. Windowed by
  -- cap_scope exactly like the free cap.
  add column discount_cap_micro_usd pg_catalog.int8 not null default 0
    check (discount_cap_micro_usd >= 0),
  -- EXPLICIT all-models intent, set only when an admin deliberately creates a
  -- lane-wide promotion with no model list. Enforcement never infers "all
  -- models" from empty membership: a scoped promotion whose member models are
  -- later cascade-deleted must match NOTHING, not silently widen to the whole
  -- catalog (a universal free tier, in the worst case).
  add column covers_all_models pg_catalog.bool not null default false;

alter table public.model_promotions
  add constraint model_promotions_providers_check
  check (
    providers <@ array[
      'openai', 'anthropic', 'gemini', 'azure_openai', 'openrouter',
      'bedrock', 'local', 'fireworks', 'modal', 'experiential_cloud'
    ]::pg_catalog.text[]
  );

-- v1 rows become labeled single-model promotions; the slug is the only name
-- they ever had.
update public.model_promotions set label = slug where label is null;
alter table public.model_promotions alter column label set not null;

-- The admin-safe seed upsert keys on label (v1 keyed on slug, which is
-- dropped below).
create unique index model_promotions_label_key
  on public.model_promotions (label);

comment on column public.model_promotions.discount_cap_micro_usd is
  'Per-org ceiling (micro-USD) on charged post-discount spend that percent_off applies to, windowed by cap_scope. 0 = the discount never expires. Enforced reservation-aware in gateway_start_attempt via gateway_promo_state.';

-- ---------------------------------------------------------------------------
-- 2. Model-scope membership. One row per (promotion, catalog model); an empty
--    membership means the promotion covers every model (lane-scoped promos).

-- Empty membership matches NOTHING unless the promotion's explicit
-- covers_all_models flag is set — so a model deletion cascading through here
-- narrows the promotion instead of widening it.
create table public.model_promotion_models (
  promotion_id pg_catalog.uuid not null
    references public.model_promotions(id) on delete cascade,
  model_id pg_catalog.uuid not null
    references public.models(id) on delete cascade,
  -- Public catalog slug (== models.slug == gateway_requests.alias), duplicated
  -- so reserve-time matching never joins models (same rationale as v1's slug).
  slug pg_catalog.text not null,
  primary key (promotion_id, model_id)
);

create index model_promotion_models_slug_idx
  on public.model_promotion_models (slug);

comment on table public.model_promotion_models is
  'Model scope of a promotion: one row per covered public catalog model. Empty membership matches nothing unless model_promotions.covers_all_models is set (a lane-wide promotion); a cascade-emptied scope therefore narrows, never widens. slug mirrors models.slug for reserve-time matching.';

grant select on public.model_promotion_models to authenticated;
grant select, insert, update, delete on public.model_promotion_models to service_role;

-- v1 rows: each promotion covered exactly its one model.
insert into public.model_promotion_models (promotion_id, model_id, slug)
select promotions.id, promotions.model_id, promotions.slug
  from public.model_promotions promotions;

-- Retire the v1 identity columns (greenfield: no compatibility aliases). The
-- model cascade now retires membership rows instead of whole promotions; a
-- promotion whose last member model is deleted matches nothing (its
-- covers_all_models flag is false).
drop index public.model_promotions_slug_key;
drop index public.model_promotions_model_id_key;
alter table public.model_promotions
  drop column model_id,
  drop column slug;

-- ---------------------------------------------------------------------------
-- 3. Notices rekey: the one-time free-exhaustion notice is per PROMOTION now
--    (its free cap spans the whole scope), not per model slug.

alter table public.model_promotion_notices
  add column promotion_id pg_catalog.uuid
    references public.model_promotions(id) on delete cascade;

update public.model_promotion_notices notices
   set promotion_id = membership.promotion_id
  from public.model_promotion_models membership
 where membership.slug = notices.model_slug;

-- A notice whose promotion was deleted before this migration has nothing to
-- attach to; dropping it merely lets P1030 fire once more if an identical
-- promotion is ever recreated.
delete from public.model_promotion_notices where promotion_id is null;

alter table public.model_promotion_notices
  drop constraint model_promotion_notices_pkey,
  drop column model_slug,
  alter column promotion_id set not null,
  add primary key (org_id, promotion_id, period_key);

-- ---------------------------------------------------------------------------
-- 4. Attempt-level promo attribution. Both cap sums key on (org, promotion),
--    so the attempt row records WHICH promotion funded/discounted it.

alter table public.gateway_attempts
  add column promo_id pg_catalog.uuid;

comment on column public.gateway_attempts.promo_id is
  'The model_promotions row that made this attempt promo-funded or promo-discounted; null for non-promo attempts. Both promo caps sum attempts by (org_id, promo_id), reservation-aware.';

-- v1 attempts: the (unique) promotion for the requested alias.
update public.gateway_attempts attempts
   set promo_id = membership.promotion_id
  from public.gateway_requests requests
  join public.model_promotion_models membership
    on membership.slug = requests.alias
 where requests.request_id = attempts.request_id
   and (attempts.promo_funded or attempts.promo_discount_percent > 0);

-- Replaces v1's alias-join scan index: both cap sums now read one org's
-- attempts for one promotion, period-bounded for recurring scopes.
drop index public.gateway_attempts_promo_idx;
create index gateway_attempts_promo_spend_idx
  on public.gateway_attempts (org_id, promo_id, budget_period_start)
  where promo_id is not null;

-- ---------------------------------------------------------------------------
-- 5. gateway_promo_state v2: resolve the winning promotion for one
--    (org, requested slug, attempt provider) and report BOTH cap states.
--    Candidates match on model membership (or empty membership) AND provider
--    list (or empty list). Among candidates the org can still use, a usable
--    free tier beats a usable discount (customer-best); with none usable the
--    free-tier-bearing candidate is reported so the P1030/P1031 transitions
--    keep firing for it.

drop function public.gateway_promo_state(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8
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
  -- once — this runs under the organizations money lock, so the aggregate
  -- scans must not repeat per priority tier. Model scope: explicit membership
  -- or the deliberate covers_all_models flag; empty membership without the
  -- flag (a cascade-emptied scope) matches nothing. Lane scope: empty = any
  -- provider.
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
    -- No active promotion matches this (model, provider).
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
  'Winning promotion state for one (org, requested slug, attempt provider, worst case): both cap states (free allowance and charged-discount ceiling), scope window, and the one-time notice flag. A usable free tier beats a usable discount; with neither usable the free-tier-bearing candidate is reported so the P1030/P1031 transitions keep firing. Reservation-aware under the organizations row lock.';

-- ---------------------------------------------------------------------------
-- 6. Notice marker keyed by promotion. The ledger learns the promotion id from
--    the P1030 exception's DETAIL field (set in gateway_start_attempt below).

drop function public.gateway_mark_promo_notified(pg_catalog.uuid, pg_catalog.text);

create function public.gateway_mark_promo_notified(
  p_org_id pg_catalog.uuid,
  p_promotion_id pg_catalog.uuid
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
   where promotions.id = p_promotion_id
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
  insert into public.model_promotion_notices (org_id, promotion_id, period_key)
  values (p_org_id, p_promotion_id, v_period_key)
  on conflict (org_id, promotion_id, period_key) do nothing;
end;
$$;

revoke all on function public.gateway_mark_promo_notified(
  pg_catalog.uuid, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.gateway_mark_promo_notified(
  pg_catalog.uuid, pg_catalog.uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- 7. gateway_start_attempt: same body as 20260828210000 except the four promo
--    seams — the state read passes the ATTEMPT's provider (lane-scoped
--    promotions), the discount only applies while discount_active (the new
--    charged-spend ceiling), the P1030 refusal carries the promotion id in
--    DETAIL (the ledger's out-of-band notice marker is promotion-keyed now),
--    and the attempt row records promo_id for the cap sums.

CREATE OR REPLACE FUNCTION public.gateway_start_attempt(p_request_id text, p_org_id uuid, p_attempt_ordinal integer, p_route_depth integer, p_deployment_id text, p_provider text, p_exact_model_id text, p_pool_id text, p_catalog_sha256 text, p_billing_source text, p_pricing_source text, p_pricing_effective_at timestamp with time zone, p_input_rate_micro_usd bigint, p_cached_input_rate_micro_usd bigint, p_output_rate_micro_usd bigint, p_reasoning_rate_micro_usd bigint, p_maximum_cost_micro_usd bigint)
 RETURNS TABLE(attempt_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_request public.gateway_requests%rowtype;
  v_existing public.gateway_attempts%rowtype;
  v_attempt_id pg_catalog.text;
  v_period_start pg_catalog.timestamptz;
  v_limits public.gateway_key_limits%rowtype;
  v_rpm pg_catalog.int4;
  v_tpm pg_catalog.int4;
  v_cap pg_catalog.int8;
  v_recent pg_catalog.int8;
  v_recent_tokens pg_catalog.int8;
  v_spent_today pg_catalog.int8;
  v_policy record;
  -- gw-identity P-C additions: the request's budget-scope coordinates and the
  -- budget gate's verdict.
  v_identity_id pg_catalog.text;
  v_alias_id pg_catalog.text;
  v_budget_policy record;
  -- Promotional-model funding state and the resolved funding lane for this
  -- attempt ('promo' = free, does not draw credits; 'credits' = normal gates).
  v_promo record;
  v_funding pg_catalog.text := 'credits';
  -- Promo percent discount for a credit-funded promo attempt (0 otherwise) and
  -- the worst-case amount the credit gates and the reservation actually charge,
  -- net of that discount. Defaults to the full worst case (non-promo / BYOK).
  v_percent_off pg_catalog.numeric := 0;
  v_charge_worst pg_catalog.int8 := coalesce(p_maximum_cost_micro_usd, 0);
  -- Attribution for the promotion cap sums, resolved on the host lane only.
  -- A plain variable rather than v_promo.promo_id in the insert: BYOK skips
  -- the whole host_managed block, leaving v_promo unassigned, and plpgsql
  -- resolves record fields in an expression even on an untaken CASE branch.
  v_promo_id pg_catalog.uuid := null;
  -- Pre-verify allowance.
  v_allowance pg_catalog.int8;
  v_pre_verify_spent pg_catalog.int8;
begin
  perform public.gateway_require_service_role();
  if p_billing_source not in ('customer_managed', 'host_managed') then
    raise exception using errcode = '22023',
      message = 'invalid gateway attempt billing source';
  end if;
  select requests.* into v_request
    from public.gateway_requests requests
   where requests.request_id = p_request_id
   for update;
  if v_request.request_id is null then
    raise exception using errcode = 'P0002',
      message = 'gateway attempt request was not durably accepted';
  end if;
  if v_request.org_id <> p_org_id then
    raise exception using errcode = '23514',
      message = 'gateway attempt authority differs from the accepted request';
  end if;
  -- Replay receipt: a retried dispatch RPC (response lost after commit)
  -- returns the durable attempt id instead of a raw unique violation, and
  -- never re-reserves. Checked before the terminal/deadline gates so a late
  -- retry can still learn the id it needs to settle.
  select attempts.* into v_existing
    from public.gateway_attempts attempts
   where attempts.request_id = p_request_id
     and attempts.attempt_ordinal = p_attempt_ordinal;
  if v_existing.attempt_id is not null then
    if v_existing.org_id <> p_org_id
       or v_existing.deployment_id <> p_deployment_id
       or v_existing.billing_source <> p_billing_source then
      raise exception using errcode = '23505',
        message = 'gateway attempt ordinal is bound to a different dispatch';
    end if;
    return query select v_existing.attempt_id;
    return;
  end if;
  if v_request.terminal_state is not null then
    raise exception using errcode = '23514',
      message = 'gateway attempt request is already terminal';
  end if;
  if v_request.deadline_at <= pg_catalog.clock_timestamp() then
    -- Dispatching past the deadline would pay a provider for work the
    -- reconciler is already entitled to insure at zero.
    raise exception using errcode = '23514',
      message = 'gateway attempt request deadline has passed';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = v_request.api_key_id
      and keys.revoked_at is null
      and (keys.expires_at is null
        or keys.expires_at > pg_catalog.clock_timestamp())
  ) then
    -- Revocation bounds new provider streams: a key revoked between accept
    -- and dispatch must not keep spending on either lane.
    raise exception using errcode = '42501',
      message = 'gateway attempt api key is revoked or expired';
  end if;
  v_period_start := pg_catalog.date_trunc(
    'day', pg_catalog.clock_timestamp() at time zone 'UTC'
  ) at time zone 'UTC';

  if p_billing_source = 'host_managed' then
    -- Serialize all money decisions for the organization.
    perform 1 from public.organizations orgs
     where orgs.id = p_org_id
     for update;
    select limits.* into v_limits
      from public.gateway_key_limits limits
     where limits.api_key_id = v_request.api_key_id;
    if v_limits.api_key_id is not null then
      v_rpm := v_limits.requests_per_minute;
      v_tpm := v_limits.tokens_per_minute;
      v_cap := v_limits.daily_spend_cap_micro_usd;
    else
      v_rpm := 60;
      v_tpm := null;
      v_cap := case
        when public.gateway_org_free_credit_funded(p_org_id) then 50000000
        else null
      end;
    end if;
    -- RPM/TPM/price-unknown apply to EVERY host-lane dispatch (abuse and
    -- fail-closed guards), independent of whether the request is promo-funded
    -- or credit-funded; they run before the funding split.
    if v_rpm is not null then
      -- Count HOST-LANE dispatches only, so "BYOK traffic is never rate
      -- limited" holds in behavior: pass-through acceptance and dispatch
      -- never move this counter. Reads the attempt's own denormalized key so
      -- the scan is bounded by the 60s window (gateway_attempts_key_started_idx),
      -- not the key's lifetime request count.
      select pg_catalog.count(*) into v_recent
        from public.gateway_attempts attempts
       where attempts.api_key_id = v_request.api_key_id
         and attempts.billing_source = 'host_managed'
         and attempts.started_at
           >= pg_catalog.clock_timestamp() - pg_catalog.interval '60 seconds';
      if v_recent >= v_rpm then
        raise exception using errcode = 'P1012',
          message = pg_catalog.format(
            'key_rate_limit: this API key exceeded %s platform-funded '
            || 'dispatches per minute; slow down, or raise the key''s limit '
            || 'via the gateway key-limits API (BYOK dispatch is never '
            || 'counted or blocked)',
            v_rpm
          );
      end if;
    end if;
    if v_tpm is not null then
      -- TPM is trailing observation: token counts exist only after an attempt
      -- settles, so sum the settled tokens of attempts that went terminal in
      -- the last 60s and refuse the NEXT dispatch once the limit is met. A
      -- single large stream may overshoot; the key then waits out the window.
      -- Host lane only, like every money gate here.
      select coalesce(pg_catalog.sum(
          coalesce(attempts.input_tokens, 0)
          + coalesce(attempts.cached_input_tokens, 0)
          + coalesce(attempts.output_tokens, 0)
          + coalesce(attempts.reasoning_tokens, 0)), 0)
        into v_recent_tokens
        from public.gateway_attempts attempts
       where attempts.api_key_id = v_request.api_key_id
         and attempts.billing_source = 'host_managed'
         and attempts.terminal_at is not null
         and attempts.terminal_at
           >= pg_catalog.clock_timestamp() - pg_catalog.interval '60 seconds';
      if v_recent_tokens >= v_tpm then
        raise exception using errcode = 'P1022',
          message = pg_catalog.format(
            'key_token_rate_limit: this API key''s platform-funded traffic '
            || 'settled %s tokens in the last 60 seconds, at or past its %s '
            || 'tokens-per-minute limit; wait for the window to drain, or '
            || 'raise the key''s limit via the gateway key-limits API (BYOK '
            || 'dispatch is never counted or blocked)',
            v_recent_tokens, v_tpm
          );
      end if;
    end if;
    if p_maximum_cost_micro_usd is null then
      -- An unknown worst-case price cannot be bounded against a daily spend
      -- cap, the org credit balance, a per-scope budget, OR the promo cap:
      -- reserving it as $0 (the historical coalesce below) slipped every one of
      -- those gates and let settlement drive the account negative. The ROUTE is
      -- ineligible (deployment scope; the waterfall advances to a known-price
      -- route, or the request fails if none is priced). Fires regardless of
      -- whether a daily cap applies, and BEFORE the balance/budget/promo checks
      -- below, so no unknown price ever reaches them. BYOK is unaffected.
      raise exception using errcode = 'P1013',
        message = 'deployment_price_unknown: this route has no known price, so '
          || 'its spend cannot be bounded against the credit balance, a daily '
          || 'cap, or a scope budget; it is ineligible and another route may '
          || 'serve the request';
    end if;

    -- Promo funding split, v2: the winning promotion for this (org, alias,
    -- ATTEMPT PROVIDER) — lane-scoped promotions only match the rungs they
    -- name. A request under a usable free tier is promo-funded (FREE) and
    -- skips the credit gates; everything else takes the credits path, where
    -- percent_off discounts the charge WHILE the org is under the promotion's
    -- charged-spend ceiling (discount_active). Monotonic: once the exhaustion
    -- notice is delivered for this (org, promotion, period), later requests
    -- draw credits even if a sliver of promo would still fit.
    select promo.is_promo, promo.promo_id, promo.within_cap, promo.notified,
           promo.cap_micro_usd, promo.promo_spent_micro_usd,
           promo.percent_off, promo.has_free_tier, promo.discount_active
      into v_promo
      from public.gateway_promo_state(
        p_org_id, v_request.alias, p_provider, p_maximum_cost_micro_usd
      ) promo;
    -- Free (promo-funded) only when a free tier exists and this org is still
    -- under it and has not been notified of exhaustion. A pure-discount promo
    -- (no free tier) or an exhausted/notified free tier takes the credits path,
    -- where percent_off discounts the charge.
    if v_promo.is_promo and v_promo.has_free_tier
       and v_promo.within_cap and not v_promo.notified then
      v_funding := 'promo';
    else
      v_funding := 'credits';
    end if;
    -- Resolve the credit-charge worst case for this attempt. A credit-funded
    -- promo with an ACTIVE discount charges (1 - percent_off/100) of the full
    -- worst case; a promotion whose charged-spend ceiling is reached charges
    -- list price (percent 0). Every credit/budget/cap gate below and the
    -- reservation use this figure so the reservation and the eventual settled
    -- charge agree.
    v_percent_off := case
      when v_promo.is_promo and v_promo.discount_active
        then coalesce(v_promo.percent_off, 0)
      else 0
    end;
    if v_funding = 'credits' and v_percent_off > 0 then
      v_charge_worst := pg_catalog.round(
        coalesce(p_maximum_cost_micro_usd, 0)::pg_catalog.numeric
        * (100 - v_percent_off) / 100
      )::pg_catalog.int8;
    else
      v_charge_worst := coalesce(p_maximum_cost_micro_usd, 0);
    end if;
    if v_funding = 'promo' or v_percent_off > 0 then
      v_promo_id := v_promo.promo_id;
    end if;

    if v_funding = 'credits' then
      -- Promo exhaustion transition (3a/3c). A promo model on the credits path
      -- is here because the cap is reached. If the org has NOT been notified,
      -- this is the visible switch: refuse once with P1030 (the ledger commits
      -- the one-time notice marker out of band, so the retry falls through to
      -- the credit gates). If already notified, fall through; a later
      -- insufficient_credits below becomes P1031 (BYOK-only) for a promo model.
      -- Only fire the free->credits switch notice when a free tier actually
      -- existed and is now exhausted (has_free_tier). A pure-discount promo
      -- (cap 0) has no free phase, so it never announces one; it just applies
      -- the discount on the credits path below. DETAIL carries the promotion
      -- id: the ledger's out-of-band notice marker is promotion-keyed.
      if v_promo.is_promo and v_promo.has_free_tier and not v_promo.notified then
        raise exception using errcode = 'P1030',
          detail = v_promo.promo_id::pg_catalog.text,
          message = pg_catalog.format(
            'promo_exhausted_notice: your free promo for %s is used up ($%s of '
            || '$%s). Further requests to this model now draw your '
            || 'organization''s platform credits%s -- retry to continue. '
            || 'Requests using your own provider keys (BYOK) are unaffected.',
            v_request.alias,
            pg_catalog.to_char(
              v_promo.promo_spent_micro_usd::pg_catalog.numeric / 1000000,
              'FM999999990.00'),
            pg_catalog.to_char(
              v_promo.cap_micro_usd::pg_catalog.numeric / 1000000,
              'FM999999990.00'),
            case when v_percent_off > 0
              then ' at ' || pg_catalog.to_char(v_percent_off, 'FM999999990.##') || '% off'
              else '' end
          );
      end if;

      -- Spend gate, decoupled from login, RELAXED to a cumulative allowance
      -- (money half of instant signup). An org whose founding admin exists but
      -- whose spend_unlocked_at is null may draw platform credits only up to
      -- app_settings.pre_verify_allowance_micro_usd (default $1) of cumulative
      -- charged-or-reserved spend, then P1025 blocks the rest until they verify;
      -- an allowance of 0 blocks all unverified credit spend (prior behavior).
      -- Promo-free spend never counts (promo attempts hold 0 in budget_*).
      -- Fires FIRST in the credit path, before any cap/budget check, and only
      -- when a present admin membership exists -- so a membership-less fixture
      -- org is never gated. BYOK skips this whole block.
      if exists (
        select 1
          from public.organization_members members
          join public.organizations orgs on orgs.id = members.org_id
         where members.org_id = p_org_id
           and members.role = 'admin'
           and orgs.spend_unlocked_at is null
      ) then
        v_allowance := public.gateway_pre_verify_allowance_micro_usd();
        select coalesce(pg_catalog.sum(
            case when attempts.state = 'dispatched'
              then attempts.budget_reserved_micro_usd
              else coalesce(attempts.budget_settled_micro_usd, 0)
            end), 0)
          into v_pre_verify_spent
          from public.gateway_attempts attempts
         where attempts.org_id = p_org_id
           and attempts.billing_source = 'host_managed';
        if v_pre_verify_spent + v_charge_worst > v_allowance then
          raise exception using errcode = 'P1025',
            message = case
              when v_allowance <= 0 then
                'org_owner_unverified: confirm your email to spend platform '
                || 'credits -- check your inbox for the verification link; '
                || 'everything else, including BYOK (your own provider keys) '
                || 'and trace uploads, works now'
              else
                'org_owner_unverified: your organization has used its $'
                || pg_catalog.to_char(
                     v_allowance::pg_catalog.numeric / 1000000,
                     'FM999999990.00')
                || ' pre-verification credit allowance ($'
                || pg_catalog.to_char(
                     v_pre_verify_spent::pg_catalog.numeric / 1000000,
                     'FM999999990.00')
                || ' used); confirm your email to spend the rest of your '
                || 'credits -- check your inbox for the verification link. '
                || 'BYOK (your own provider keys) and trace uploads are '
                || 'unaffected'
            end;
        end if;
      end if;

      if v_cap is not null then
        select coalesce(pg_catalog.sum(
            case when attempts.state = 'dispatched'
              then attempts.budget_reserved_micro_usd
              else coalesce(attempts.budget_settled_micro_usd, 0)
            end), 0)
          into v_spent_today
          from public.gateway_attempts attempts
         where attempts.api_key_id = v_request.api_key_id
           and attempts.billing_source = 'host_managed'
           and attempts.budget_period_start = v_period_start;
        if v_spent_today + v_charge_worst > v_cap then
          raise exception using errcode = 'P1011',
            message = pg_catalog.format(
              'key_daily_cap: this request''s worst case (%s micro-USD) would '
              || 'push the key past its %s micro-USD daily cap (%s already '
              || 'reserved or settled today, UTC); retry after 00:00 UTC or '
              || 'raise the cap via the gateway key-limits API',
              v_charge_worst, v_cap, v_spent_today
            );
        end if;
      end if;
      select policy.allowed, policy.reason_code, policy.message into v_policy
        from public.gateway_spend_policy_check(
          p_org_id, p_exact_model_id, v_charge_worst
        ) policy;
      if not v_policy.allowed then
        -- A promo model whose free allowance is spent AND whose org credits
        -- cannot cover it is BYOK-only for that org (3c): the platform stops
        -- serving it on the house lane. Surface P1031 so the terminal state is
        -- unambiguous; every other refusal keeps billing's own codes.
        if v_promo.is_promo and v_policy.reason_code = 'insufficient_credits' then
          raise exception using errcode = 'P1031',
            message = pg_catalog.format(
              'promo_byok_only: your free promo for %s is used up and your '
              || 'organization''s credits cannot cover it, so %s is now '
              || 'available only with your own provider keys (BYOK). Add '
              || 'credits at %s/credits to serve it on the platform again; '
              || 'BYOK requests are unaffected.',
              v_request.alias, v_request.alias, public.gateway_webapp_url()
            );
        end if;
        raise exception using
          errcode = case v_policy.reason_code
            when 'insufficient_credits' then 'P1010'
            when 'org_daily_cap' then 'P1014'
            when 'model_daily_cap' then 'P1015'
            else 'P1010'
          end,
          message = coalesce(
            v_policy.message,
            'insufficient_credits: the organization''s credit balance is exhausted'
          );
      end if;

      -- gw-identity P-C: per-scope monthly budgets, composed ALONGSIDE billing's
      -- caps above -- both must pass. Resolve the request's budget-scope
      -- coordinates (identity from the key, alias from the frozen revision; both
      -- may be null for a hard-deleted key/unknown revision, which simply cannot
      -- match an identity/pool/deployment budget) and reject if any governing
      -- budget row would be exceeded. Still under the organizations row lock, so
      -- the check stays reservation-aware exactly like the caps.
      select keys.identity_id into v_identity_id
        from public.api_keys keys
       where keys.id = v_request.api_key_id;
      select revisions.alias_id into v_alias_id
        from public.gateway_alias_revisions revisions
       where revisions.revision_id = v_request.alias_revision_id;
      select budget.allowed, budget.reason_code, budget.message
        into v_budget_policy
        from public.gateway_budget_reservation_check(
          p_org_id, v_request.api_key_id, v_identity_id, v_alias_id, p_pool_id,
          p_deployment_id,
          -- The discounted worst case this attempt will actually charge credits.
          -- Non-null here (P1013 already rejected an unknown host price), so the
          -- budget gate bounds the real credit impact, promo discount included.
          v_charge_worst
        ) budget;
      if not v_budget_policy.allowed then
        raise exception using
          errcode = case v_budget_policy.reason_code
            when 'budget_team' then 'P1016'
            when 'budget_identity' then 'P1017'
            when 'budget_pool' then 'P1018'
            when 'budget_deployment' then 'P1019'
            when 'budget_key' then 'P1023'
            when 'budget_model' then 'P1024'
            else 'P1016'
          end,
          message = v_budget_policy.message;
      end if;
    end if;
  end if;

  v_attempt_id := 'attempt-'
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', '');
  insert into public.gateway_attempts (
    attempt_id, request_id, org_id, api_key_id, attempt_ordinal, route_depth,
    deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
    billing_source, pricing_source, pricing_effective_at,
    input_rate_micro_usd, cached_input_rate_micro_usd,
    output_rate_micro_usd, reasoning_rate_micro_usd,
    state, started_at, budget_period_start, budget_reserved_micro_usd,
    promo_funded, promo_reserved_micro_usd, promo_discount_percent, promo_id
  ) values (
    v_attempt_id, p_request_id, p_org_id, v_request.api_key_id,
    p_attempt_ordinal, p_route_depth,
    p_deployment_id, p_provider, p_exact_model_id, p_pool_id, p_catalog_sha256,
    p_billing_source, p_pricing_source, p_pricing_effective_at,
    p_input_rate_micro_usd, p_cached_input_rate_micro_usd,
    p_output_rate_micro_usd, p_reasoning_rate_micro_usd,
    'dispatched', pg_catalog.clock_timestamp(), v_period_start,
    -- Promo-funded attempts hold their FULL worst case in promo_reserved and 0
    -- in budget_reserved (no credit/budget/cap read counts them). Credit-funded
    -- attempts reserve the discounted worst case against credits.
    case when v_funding = 'promo' then 0 else v_charge_worst end,
    v_funding = 'promo',
    case when v_funding = 'promo'
         then coalesce(p_maximum_cost_micro_usd, 0) else 0 end,
    -- Freeze the discount for settlement; free promo attempts carry 0 (they are
    -- fully free via the promo columns, not a credit discount).
    case when v_funding = 'credits' then v_percent_off else 0 end,
    -- Attribution for the promotion's cap sums: set whenever this attempt is
    -- promo-funded or promo-discounted, null otherwise (always null for BYOK).
    v_promo_id
  );
  return query select v_attempt_id;
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 8. Atomic admin apply: terms + model scope in ONE transaction. PostgREST
--    cannot span the promotion row and its membership, and every partial
--    order of separate calls is wrong somewhere: terms-then-scope can commit
--    new terms onto the old scope, scope-then-terms the reverse, and a
--    membership delete/insert pair can die leaving EMPTY membership (= "all
--    models" through the promotion's lanes) or a removed model still
--    subsidized. One definer function applies the full resource atomically;
--    the gateway's single-statement reads see the old promotion or the new
--    one, never a mixture. p_promotion_id null = create.

create function public.model_promotion_apply(
  p_promotion_id pg_catalog.uuid,
  p_label pg_catalog.text,
  p_providers pg_catalog.text[],
  p_family_keys pg_catalog.text[],
  p_per_org_cap_micro_usd pg_catalog.int8,
  p_discount_cap_micro_usd pg_catalog.int8,
  p_cap_scope pg_catalog.text,
  p_percent_off pg_catalog.numeric,
  p_active pg_catalog.bool,
  p_display_order pg_catalog.int4,
  p_members pg_catalog.jsonb
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
      label, providers, family_keys, per_org_cap_micro_usd,
      discount_cap_micro_usd, cap_scope, percent_off, active, display_order,
      covers_all_models
    ) values (
      p_label, coalesce(p_providers, '{}'), coalesce(p_family_keys, '{}'),
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
  pg_catalog.int8, pg_catalog.int8, pg_catalog.text, pg_catalog.numeric,
  pg_catalog.bool, pg_catalog.int4, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.model_promotion_apply(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text[], pg_catalog.text[],
  pg_catalog.int8, pg_catalog.int8, pg_catalog.text, pg_catalog.numeric,
  pg_catalog.bool, pg_catalog.int4, pg_catalog.jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Deploy-window bridge: a pre-v2 gateway worker still marks the P1030
--    exhaustion notice by (org, MODEL SLUG) — staging and production migrate
--    the database BEFORE rolling workers, so without this overload the old
--    ledger's marker write fails during that window and the "one-time"
--    refusal repeats on every retry until the fleet rolls. Resolves the slug
--    to the free-tier-bearing active promotion covering it (mirroring
--    gateway_promo_state's fallback pass) and marks that promotion. Safe to
--    drop once no pre-v2 worker can run.

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
  v_promotion pg_catalog.uuid;
begin
  perform public.gateway_require_service_role();
  select promotions.id into v_promotion
    from public.model_promotions promotions
   where promotions.active
     and promotions.per_org_cap_micro_usd > 0
     and exists (
       select 1 from public.model_promotion_models members
        where members.promotion_id = promotions.id
          and members.slug = p_model_slug
     )
   order by promotions.display_order, promotions.id
   limit 1;
  if v_promotion is null then
    return;
  end if;
  perform public.gateway_mark_promo_notified(p_org_id, v_promotion);
end;
$$;

revoke all on function public.gateway_mark_promo_notified(
  pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_mark_promo_notified(
  pg_catalog.uuid, pg_catalog.text
) to service_role;
