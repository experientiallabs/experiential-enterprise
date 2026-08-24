-- ---------------------------------------------------------------------------
-- YC launch grant: bump the deal from $326 to $526 (net 526).
--
-- Product decision (the product owner, 2026-08-22): a YC signup's TOTAL launch credit is
-- now exactly $526, not $326. The standard non-YC welcome promo stays $20.
--
-- This is a SEPARATE migration, not an in-place edit of the prior YC files
-- (20260819200000_yc_claims.sql, 20260821100000_yc_grant_promo_fold.sql):
-- those were already applied on previews/staging, and a version-keyed runner
-- SKIPS an edited-but-already-applied file, so an in-place change leaves those
-- environments at $326 while fresh CI DBs look correct. A new migration
-- CREATE-OR-REPLACEs the functions, so it re-applies on BOTH a brand-new DB
-- and one that already ran the earlier YC migrations -> both end at $526.
-- (House rule: new migrations never edit existing ones.)
--
-- Both the grant (claim_yc_grant) and its expiry clawback
-- (process_yc_claim_expiries) move together: the clawback removes the UNSPENT
-- part of the grant, so it must use the same $526 figure or an unspent grant
-- would leave $200 stranded at expiry. The $20 welcome-promo reversal is
-- unchanged (it reverses whatever the signup trigger granted); only the grant
-- amount changes. Grants are re-asserted for self-containment; CREATE OR
-- REPLACE otherwise preserves the existing ACLs.
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
    -- Fresh claim: apply the one-time $526 grant, then fold the $20 welcome
    -- promo into it so the org's total launch credit is exactly $526. Both the
    -- grant and the reversal commit in the same transaction as the claim row.
    -- Orgs without a promo row (pre-promo migrations) reverse nothing; the
    -- unique (source, source_ref) index backstops both once-only writes.
    insert into public.credit_ledger
        (org_id, entry_type, amount_usd, reason, source, source_ref, created_by)
      values
        (in_org, 'grant', 526, 'YC launch grant', 'yc_launch', in_org::text, in_user::text);
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
    526::numeric,
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
-- Expiry: remove the unspent part of the $526 grant, exactly once, never below
-- zero. clawback = LEAST(balance, GREATEST(0, 526 - spent_since_claim)); the
-- 'expiry:' || org_id source_ref makes a rerun a no-op via the unique
-- (source, source_ref) index. Body is otherwise unchanged from the original
-- 20260819200000_yc_claims.sql; only the grant figure moves 326 -> 526.

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
           orgs.credit_granted_usd, orgs.billable_spend_usd
      from public.yc_claims claims
      join public.organizations orgs on orgs.id = claims.org_id
     where claims.expires_at < now()
       and claims.expiry_processed_at is null
       and claims.revoked_at is null
       -- Lock the organization counter row too, not just the claim: the clawback
       -- caps at the current balance (credit_granted_usd - billable_spend_usd),
       -- so a settlement landing between this read and the adjustment insert
       -- would otherwise let the cap use a stale, higher balance and claw the
       -- account below zero. Locking orgs serializes expiry against settlement
       -- for that one org, keeping the snapshot consistent through the insert.
       for update of claims, orgs
  loop
    clawback := least(
      claim.credit_granted_usd - claim.billable_spend_usd,
      greatest(
        0,
        526 - (claim.billable_spend_usd - claim.billable_spend_at_claim_usd)
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
        -- A prior pass inserted the adjustment but died before marking the
        -- claim processed; the marker below completes it.
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
