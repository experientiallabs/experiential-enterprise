-- ---------------------------------------------------------------------------
-- Admin-editable credit grant amounts (welcome + YC), on the app_settings
-- singleton, plus a per-claim snapshot so the YC estimate/expiry stay correct
-- when the platform-wide amount later changes.
--
-- This reconciles the credit/gating knobs into ONE place (app_settings), so the
-- admin panel's Platform section shows and controls them together:
--   welcome_grant_micro_usd  ($20 default) — the signup welcome grant
--   yc_grant_micro_usd       ($526 default) — the /yc launch grant
--   pre_verify_allowance_micro_usd ($1)    — spend allowed before inbox proof
--   spend_unlock_requirement (email|card)  — what unlocks spend (#672)
--
-- The two grant amounts become the single source of truth read by the grant
-- functions (grant_signup_promo, claim_yc_grant); the earlier YC bump migration
-- (20260828150000) hardcoded 526, and this replaces it with the setting whose
-- default IS 526, so the effective amount is unchanged until an admin edits it.
--
-- yc_claims.granted_usd snapshots the amount granted AT CLAIM TIME. The budget
-- poll (the highest-volume authenticated read, one round-trip by design) and the
-- expiry clawback read this per-claim snapshot instead of a global, so changing
-- yc_grant_micro_usd never retroactively reshapes an existing claim's estimate
-- or clawback. gateway_start_attempt is deliberately untouched.
-- ---------------------------------------------------------------------------

alter table public.app_settings
  add column welcome_grant_micro_usd pg_catalog.int8 not null default 20000000
    check (welcome_grant_micro_usd >= 0),
  add column yc_grant_micro_usd pg_catalog.int8 not null default 526000000
    check (yc_grant_micro_usd >= 0);

comment on column public.app_settings.welcome_grant_micro_usd is
  'Welcome credit granted to every new organization at signup, in micro-USD ($20 = 20000000 default). Read by grant_signup_promo(); 0 grants nothing. Editable from the admin Platform panel.';
comment on column public.app_settings.yc_grant_micro_usd is
  'YC launch grant (total, welcome promo folded in) in micro-USD ($526 = 526000000 default). Read by claim_yc_grant() and snapshotted onto yc_claims.granted_usd at claim time. Editable from the admin Platform panel.';

-- ---------------------------------------------------------------------------
-- Per-claim snapshot of the granted amount. Backfill existing claims from their
-- recorded yc_launch grant ledger row (or the $526 launch amount if absent).

alter table public.yc_claims
  add column granted_usd pg_catalog.numeric(14, 6);

update public.yc_claims claims
   set granted_usd = coalesce(
     (
       select ledger.amount_usd
         from public.credit_ledger ledger
        where ledger.org_id = claims.org_id
          and ledger.source = 'yc_launch'
          and ledger.entry_type = 'grant'
        order by ledger.created_at
        limit 1
     ),
     526
   )
 where claims.granted_usd is null;

comment on column public.yc_claims.granted_usd is
  'The YC grant amount at claim time (snapshot of app_settings.yc_grant_micro_usd / 1e6). The budget remaining-estimate and the expiry clawback read this per-claim value so a later change to the platform-wide amount never reshapes an existing claim.';

-- ---------------------------------------------------------------------------
-- Welcome grant reads the setting (was a hardcoded $20).

create or replace function public.grant_signup_promo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount pg_catalog.numeric;
begin
  select settings.welcome_grant_micro_usd::pg_catalog.numeric / 1000000
    into v_amount
    from public.app_settings settings
    limit 1;
  -- A zero (or unset) welcome amount grants nothing rather than writing a $0
  -- ledger row.
  if coalesce(v_amount, 0) > 0 then
    insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source)
    values (new.id, 'grant', v_amount, 'Welcome credit', 'signup_promo');
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- YC claim reads the setting and snapshots it onto the claim row.

create or replace function public.claim_yc_grant(in_org uuid, in_user uuid)
returns table (
  claimed_at timestamptz,
  expires_at timestamptz,
  granted_usd numeric,
  balance_usd numeric,
  org_slug text,
  org_name text,
  user_email text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  org_row public.organizations%rowtype;
  claim_row public.yc_claims%rowtype;
  promo_granted numeric;
  v_grant numeric;
begin
  select * into org_row from public.organizations orgs where orgs.id = in_org;
  if not found then
    raise exception 'organization not found: %', in_org
      using errcode = 'P0002';
  end if;
  select settings.yc_grant_micro_usd::numeric / 1000000
    into v_grant
    from public.app_settings settings
    limit 1;
  v_grant := coalesce(v_grant, 526);
  -- Claim once per org AND once per user. A retry after a committed-but-lost
  -- response must be idempotent: re-inserting hits a unique column, so on
  -- conflict we return the EXISTING claim and current balance instead of a bare
  -- 409, and never write a second grant or reversal. A PARTIAL conflict (this
  -- user already claimed a different org, or this org was claimed by another
  -- user) is a genuine collision and still surfaces as 23505 -> 409.
  insert into public.yc_claims
      (org_id, claimed_by, expires_at, billable_spend_at_claim_usd, granted_usd)
    values
      (in_org, in_user, now() + interval '3 months', org_row.billable_spend_usd, v_grant)
    on conflict do nothing
    returning * into claim_row;
  if found then
    -- Fresh claim: apply the one-time grant, then fold the $20 welcome promo
    -- into it so the org's total launch credit is exactly the grant amount.
    -- Both the grant and the reversal commit in the same transaction as the
    -- claim row. Orgs without a promo row reverse nothing; the unique
    -- (source, source_ref) index backstops both once-only writes.
    insert into public.credit_ledger
        (org_id, entry_type, amount_usd, reason, source, source_ref, created_by)
      values
        (in_org, 'grant', v_grant, 'YC launch grant', 'yc_launch', in_org::text, in_user::text);
    select coalesce(sum(ledger.amount_usd), 0)
      into promo_granted
      from public.credit_ledger ledger
     where ledger.org_id = in_org
       and ledger.source = 'signup_promo';
    if promo_granted > 0 then
      insert into public.credit_ledger
          (org_id, entry_type, amount_usd, reason, source, source_ref, created_by)
        values
          (in_org, 'adjustment', -promo_granted,
           'Welcome credit folded into the YC launch grant', 'yc_launch',
           'promo-reversal:' || in_org, in_user::text);
    end if;
  else
    select * into claim_row from public.yc_claims claims
      where claims.org_id = in_org and claims.claimed_by = in_user;
    if not found then
      raise exception 'yc grant already claimed for this org or user'
        using errcode = '23505';
    end if;
  end if;
  return query
  select
    claim_row.claimed_at,
    claim_row.expires_at,
    claim_row.granted_usd,
    orgs.credit_granted_usd - orgs.billable_spend_usd,
    orgs.slug,
    orgs.name,
    (select users.email::text from auth.users users where users.id = in_user)
  from public.organizations orgs
  where orgs.id = in_org;
end;
$$;

revoke all on function public.claim_yc_grant(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_yc_grant(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Expiry claws back the unspent part of THIS claim's snapshotted grant.

create or replace function public.process_yc_claim_expiries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim record;
  clawback numeric;
  processed integer := 0;
begin
  for claim in
    select claims.id, claims.org_id, claims.billable_spend_at_claim_usd,
           coalesce(claims.granted_usd, 526) as granted_usd,
           orgs.credit_granted_usd, orgs.billable_spend_usd
      from public.yc_claims claims
      join public.organizations orgs on orgs.id = claims.org_id
     where claims.expires_at < now()
       and claims.expiry_processed_at is null
       and claims.revoked_at is null
       for update of claims, orgs
  loop
    clawback := least(
      claim.credit_granted_usd - claim.billable_spend_usd,
      greatest(
        0,
        claim.granted_usd - (claim.billable_spend_usd - claim.billable_spend_at_claim_usd)
      )
    );
    if clawback > 0 then
      begin
        insert into public.credit_ledger
            (org_id, entry_type, amount_usd, reason, source, source_ref)
          values
            (claim.org_id, 'adjustment', -clawback,
             'YC credits expired (3 months)', 'yc_launch',
             'expiry:' || claim.org_id);
      exception when unique_violation then
        null;
      end;
    end if;
    update public.yc_claims
       set expiry_processed_at = now()
     where id = claim.id;
    processed := processed + 1;
  end loop;
  return processed;
end;
$$;

revoke all on function public.process_yc_claim_expiries()
  from public, anon, authenticated;
grant execute on function public.process_yc_claim_expiries() to service_role;
