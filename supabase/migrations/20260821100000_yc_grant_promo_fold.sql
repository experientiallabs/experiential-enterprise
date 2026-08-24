-- ---------------------------------------------------------------------------
-- YC launch grant: fold the $20 welcome promo INTO the $326 grant (net 326).
--
-- Product reversal (the product owner, 2026-08-20): a YC signup's TOTAL launch credit is
-- exactly $326, not $346. The original 20260819200000_yc_claims.sql shipped
-- claim_yc_grant() stacking the $326 on the signup trigger's $20 signup_promo,
-- so every fresh YC claim netted $346.
--
-- This is a SEPARATE migration, not an in-place edit of 20260819200000: that
-- file was already applied on the preview (and will be on staging), and a
-- version-keyed migration runner SKIPS an edited-but-already-applied file, so
-- an in-place change leaves those environments at $346 while fresh CI DBs look
-- correct. A new migration CREATE-OR-REPLACEs the function, so it re-applies on
-- BOTH a brand-new DB and one that already ran the old yc_claims -> both end at
-- $326. (House rule: new migrations never edit existing ones.)
--
-- The reversal is an auditable yc_launch adjustment keyed promo-reversal:{org},
-- once-only via the (source, source_ref) unique index; orgs with no recorded
-- promo reverse nothing; non-YC orgs are untouched (they keep their $20).
-- process_yc_claim_expiries() is unchanged in body; its service_role grant is
-- re-asserted here because the original file granted neither function to
-- service_role (the pgTAP suite asserts both, and PostgREST rpc runs AS
-- service_role). CREATE OR REPLACE preserves the existing revoke ACL; the
-- explicit revoke/grant below keep this migration self-contained and correct
-- regardless of the prior state.
-- ---------------------------------------------------------------------------

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
begin
  select * into org_row from public.organizations orgs where orgs.id = in_org;
  if not found then
    raise exception 'organization not found: %', in_org
      using errcode = 'P0002';
  end if;
  -- Claim once per org AND once per user. A retry after a committed-but-lost
  -- response (retryable transport error) must be idempotent: re-inserting hits
  -- a unique column, so on conflict we return the EXISTING claim and current
  -- balance instead of a bare 409, and never write a second grant or reversal.
  -- Only a replay of the SAME (org, user) is idempotent; a PARTIAL conflict
  -- (this user already claimed a different org, or this org was claimed by
  -- another user) is a genuine collision and still surfaces as 23505 -> 409.
  insert into public.yc_claims
      (org_id, claimed_by, expires_at, billable_spend_at_claim_usd)
    values
      (in_org, in_user, now() + interval '3 months', org_row.billable_spend_usd)
    on conflict do nothing
    returning * into claim_row;
  if found then
    -- Fresh claim: apply the one-time $326 grant, then fold the $20 welcome
    -- promo into it so the org's total launch credit is exactly $326. Both the
    -- grant and the reversal commit in the same transaction as the claim row.
    -- Orgs without a promo row (pre-promo migrations) reverse nothing; the
    -- unique (source, source_ref) index backstops both once-only writes.
    insert into public.credit_ledger
        (org_id, entry_type, amount_usd, reason, source, source_ref, created_by)
      values
        (in_org, 'grant', 326, 'YC launch grant', 'yc_launch', in_org::text, in_user::text);
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
    -- Conflict: idempotent only when this exact (org, user) already holds it.
    select * into claim_row from public.yc_claims claims
      where claims.org_id = in_org and claims.claimed_by = in_user;
    if not found then
      raise exception 'yc grant already claimed for this org or user'
        using errcode = '23505';
    end if;
    -- Same (org, user) replay: grant + reversal already committed alongside the
    -- claim row, so fall through and return it without re-applying either.
  end if;
  return query
  select
    claim_row.claimed_at,
    claim_row.expires_at,
    326::numeric,
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

grant execute on function public.process_yc_claim_expiries() to service_role;
