-- Org special-attribute labels + internal admin notes, plus promotion audience
-- targeting keyed on those labels.
--
-- Three tightly-coupled pieces ship together because the promotion audience
-- feature (section 5-6) reads org_labels (section 1); org_labels must therefore
-- exist before anything references it, which is why this is one file.
--
--   * org_labels        extensible per-org badges (an arbitrary slug; the
--                       display text + color live in web code). YC is the first
--                       kind, backfilled from yc_claims (section 3).
--   * org_admin_notes   internal, platform-admin-only notes on an org; all
--                       admins see all notes, each note author-attributed.
--   * model_promotions.audience_labels  a promotion may be limited to accounts
--                       carrying ALL of a set of org_labels (empty = all
--                       accounts). Enforced in the money path (gateway_promo_state).
--
-- Every write path is service-role only through SECURITY DEFINER functions
-- guarded by public.gateway_require_service_role(); RLS is enabled with no
-- public policies. Additive and idempotent: new tables, definer functions, one
-- additive nullable-defaulted column, an idempotent backfill, and drop/recreate
-- of two existing definer functions with unchanged behavior except the audience
-- predicate. No destructive data operations.

-- ---------------------------------------------------------------------------
-- 0. Shared label-key validation. A label key is a short lowercase slug; the
--    same shape gates org_labels.key (scalar) and model_promotions.audience_labels
--    (array). An immutable helper lets the array constraint reuse the exact
--    pattern without a per-element subquery inline in the CHECK. Pure validation
--    (no data access), security invoker: the revoke-from-public rule that governs
--    definer functions does not apply.

create function public.org_label_keys_valid(in_keys pg_catalog.text[])
returns pg_catalog.bool
language sql
immutable
set search_path = ''
as $$
  select in_keys is null or not exists (
    select 1 from pg_catalog.unnest(in_keys) k(key)
    where k.key !~ '^[a-z][a-z0-9-]{0,31}$'
  );
$$;

comment on function public.org_label_keys_valid(pg_catalog.text[]) is
  'True when every element of the array is a valid org-label key slug (^[a-z][a-z0-9-]{0,31}$). Used by the model_promotions.audience_labels CHECK.';

-- ---------------------------------------------------------------------------
-- 1. Org labels: extensible per-org badges.

create table public.org_labels (
  id pg_catalog.uuid primary key default pg_catalog.gen_random_uuid(),
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  -- Arbitrary label kind. The DB stores only the slug; the display text and
  -- badge color live in web code (apps/web/lib/admin/org-labels.ts), so a new
  -- kind needs no migration. Same slug shape as promotion audience keys.
  key pg_catalog.text not null
    check (key ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- The platform admin who applied the label. Deliberately NO foreign key to
  -- auth.users (house convention: GoTrue owns that table and it does not exist
  -- when migrations run on a fresh Docker stack). The backfill uses the all-zero
  -- sentinel to mean "applied by the system, not a person".
  created_by pg_catalog.uuid not null,
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  unique (org_id, key)
);

comment on table public.org_labels is
  'Extensible per-org special-attribute badges (e.g. yc). Stores only the slug; display text and color live in web code. Writes are service-role only through add_org_label/remove_org_label.';

create index org_labels_key_idx on public.org_labels (key);

-- Service-role only. Revoke FIRST (house style): the stack default-grants ALL to
-- service_role on new public tables; re-grant exactly the verbs the definer
-- functions and admin reads use. No RLS policies: no end-user (anon/authenticated)
-- path reads or writes labels.
alter table public.org_labels enable row level security;
revoke all on table public.org_labels
  from public, anon, authenticated, service_role;
grant select, insert, delete on public.org_labels to service_role;

create function public.add_org_label(in_org pg_catalog.uuid, in_key pg_catalog.text, in_admin pg_catalog.uuid)
returns setof public.org_labels
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  -- Idempotent: a replay of the same (org, key) leaves the existing row in
  -- place (on conflict do nothing) and returns it either way.
  insert into public.org_labels (org_id, key, created_by)
    values (in_org, in_key, in_admin)
    on conflict (org_id, key) do nothing;
  return query
    select labels.* from public.org_labels labels
     where labels.org_id = in_org and labels.key = in_key;
end;
$$;

revoke all on function public.add_org_label(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.add_org_label(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid)
  to service_role;

create function public.remove_org_label(in_org pg_catalog.uuid, in_key pg_catalog.text)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  -- Idempotent: removing an absent label is a no-op, not an error.
  delete from public.org_labels labels
   where labels.org_id = in_org and labels.key = in_key;
end;
$$;

revoke all on function public.remove_org_label(pg_catalog.uuid, pg_catalog.text)
  from public, anon, authenticated;
grant execute on function public.remove_org_label(pg_catalog.uuid, pg_catalog.text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Internal admin notes on an org. All platform admins see all notes; each
--    note is author-attributed (email denormalized because there is no
--    auth.users FK to join through). Multiple notes per org, newest first.

create table public.org_admin_notes (
  id pg_catalog.uuid primary key default pg_catalog.gen_random_uuid(),
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  -- The authoring platform admin. NO foreign key to auth.users (house
  -- convention); notes are audit records and outlive their author's account.
  author_user_id pg_catalog.uuid not null,
  -- Denormalized author email for display: with no auth.users FK there is
  -- nothing to join to, and the note must always name a person even after the
  -- account is deleted.
  author_email pg_catalog.text not null,
  body pg_catalog.text not null
    check (pg_catalog.length(pg_catalog.btrim(body)) between 1 and 4000),
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  updated_at pg_catalog.timestamptz not null default pg_catalog.now()
);

comment on table public.org_admin_notes is
  'Internal platform-admin-only notes on an org. All admins see all notes; author_email is denormalized for display since there is no auth.users FK. Writes are service-role only through add_org_admin_note/delete_org_admin_note.';

create index org_admin_notes_org_created_idx
  on public.org_admin_notes (org_id, created_at desc);

alter table public.org_admin_notes enable row level security;
revoke all on table public.org_admin_notes
  from public, anon, authenticated, service_role;
grant select, insert, delete on public.org_admin_notes to service_role;

create function public.add_org_admin_note(
  in_org pg_catalog.uuid,
  in_author pg_catalog.uuid,
  in_author_email pg_catalog.text,
  in_body pg_catalog.text
)
returns setof public.org_admin_notes
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  return query
    insert into public.org_admin_notes (org_id, author_user_id, author_email, body)
      values (in_org, in_author, in_author_email, pg_catalog.btrim(in_body))
      returning org_admin_notes.*;
end;
$$;

revoke all on function public.add_org_admin_note(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.add_org_admin_note(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text
) to service_role;

create function public.delete_org_admin_note(in_org pg_catalog.uuid, in_note pg_catalog.uuid)
returns setof public.org_admin_notes
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  -- Scoped to BOTH (org, note): a note deletes only through its own org, so a
  -- mismatched org id returns zero rows (the caller 404s) and touches nothing.
  -- Set-returning: a hit returns the deleted row, a miss returns zero rows,
  -- never a spurious all-null composite.
  return query
    delete from public.org_admin_notes notes
     where notes.id = in_note and notes.org_id = in_org
     returning notes.*;
end;
$$;

revoke all on function public.delete_org_admin_note(pg_catalog.uuid, pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.delete_org_admin_note(pg_catalog.uuid, pg_catalog.uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. One-time YC backfill: label every org that has a yc_claims row. The
--    all-zero sentinel created_by means "applied by the system", not a person.
--    Idempotent (on conflict do nothing) so a re-run or a hand-applied 'yc'
--    label is never duplicated or overwritten.

insert into public.org_labels (org_id, key, created_by)
select claims.org_id, 'yc', '00000000-0000-0000-0000-000000000000'::pg_catalog.uuid
  from public.yc_claims claims
on conflict (org_id, key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Promotion audience targeting. A promotion may be limited to accounts that
--    carry ALL of a set of org_labels; empty = applies to all accounts (the
--    default, current behavior). Mirrors the providers/family_keys text[] shape.

alter table public.model_promotions
  add column audience_labels pg_catalog.text[] not null
    default '{}'::pg_catalog.text[];

alter table public.model_promotions
  add constraint model_promotions_audience_labels_check
  check (public.org_label_keys_valid(audience_labels));

comment on column public.model_promotions.audience_labels is
  'Account-type targeting: org-label keys the org must ALL carry for the promotion to apply. Empty = applies to every account. Enforced in the money path by gateway_promo_state.';

-- ---------------------------------------------------------------------------
-- 5. gateway_promo_state: the SAME function as 20260829000000 with ONE added
--    predicate on the candidate filter -- a promotion qualifies only when its
--    audience is empty OR the org carries every required label. Nothing else
--    changes. Signature is unchanged, so drop-and-recreate the 4-arg form.

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
-- 6. model_promotion_apply: add p_audience_labels, threaded into the insert and
--    the update (coalesced to '{}'), mirroring p_providers/p_family_keys. The
--    arg list is the function's identity, so drop the old 11-arg form first.

drop function public.model_promotion_apply(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text[], pg_catalog.text[],
  pg_catalog.int8, pg_catalog.int8, pg_catalog.text, pg_catalog.numeric,
  pg_catalog.bool, pg_catalog.int4, pg_catalog.jsonb
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
      label, providers, family_keys, audience_labels, per_org_cap_micro_usd,
      discount_cap_micro_usd, cap_scope, percent_off, active, display_order,
      covers_all_models
    ) values (
      p_label, coalesce(p_providers, '{}'), coalesce(p_family_keys, '{}'),
      coalesce(p_audience_labels, '{}'),
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
  pg_catalog.numeric, pg_catalog.bool, pg_catalog.int4, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.model_promotion_apply(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text[], pg_catalog.text[],
  pg_catalog.text[], pg_catalog.int8, pg_catalog.int8, pg_catalog.text,
  pg_catalog.numeric, pg_catalog.bool, pg_catalog.int4, pg_catalog.jsonb
) to service_role;
