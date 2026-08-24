-- /yc launch grant (gw-billing-credits BC-P5): one-click $326 credit per YC
-- company, claimed self-serve from the shared /yc URL after login.
--
-- Shape:
--   yc_claims                     one row per claimed grant; org_id AND
--                                 claimed_by are both unique (one claim per
--                                 user account AND per org)
--   credit_ledger.source          gains 'yc_launch' for the grant row and the
--                                 expiry clawback adjustment
--   claim_yc_grant(org, user)     transactional claim: yc_claims row + $326
--                                 ledger grant, service-role only
--   process_yc_claim_expiries()   idempotent daily pass: at 3 months an
--                                 adjustment removes the UNSPENT part of the
--                                 grant, never pushing the balance negative
--
-- The $326 mimics the S26 batch. Stacks on the $20 everyone-promo (the
-- signup trigger is untouched). Abuse control is uniqueness + the free-credit
-- caps (BC-P6) + a Slack ping per claim + the admin revoke path, not an
-- admin gate: the whole point is self-serve one click.

-- ---------------------------------------------------------------------------
-- 1. Ledger vocabulary: the YC grant is its own auditable source.

alter table public.credit_ledger drop constraint credit_ledger_source_check;
alter table public.credit_ledger add constraint credit_ledger_source_check
  check (source in ('signup_promo', 'migration', 'admin', 'stripe', 'yc_launch'));

-- ---------------------------------------------------------------------------
-- 2. The claims table.

create table public.yc_claims (
  id uuid primary key default gen_random_uuid(),
  -- One claim per org; the cascade mirrors credit_ledger (an org deletion
  -- takes its claim record with it).
  org_id uuid not null unique references public.organizations(id) on delete cascade,
  -- One claim per user account, across every org they belong to. No FK to
  -- auth.users on purpose: deleting the account must not delete the claim
  -- record (that would re-open the org's uniqueness slot).
  claimed_by uuid not null unique,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Snapshot of organizations.billable_spend_usd at claim time. The expiry
  -- clawback removes only the UNSPENT part of the grant, and "spent since the
  -- claim" is exactly (billable_spend_usd - this) — billable_spend_usd is the
  -- platform-funded lane by definition (BYOK never moves it), and the counter
  -- delta costs one row read instead of a spend-table scan.
  billable_spend_at_claim_usd numeric(14, 6) not null,
  expiry_processed_at timestamptz,
  revoked_at timestamptz
);

comment on table public.yc_claims is
  'One row per claimed /yc launch grant ($326, 3-month expiry). org_id and claimed_by are both unique: one claim per user account AND per org. Writes are service-role only through claim_yc_grant().';
comment on column public.yc_claims.billable_spend_at_claim_usd is
  'organizations.billable_spend_usd at claim time; the expiry clawback computes spend-since-claim from the counter delta.';

alter table public.yc_claims enable row level security;

-- Members read their own org's claim (the budget payload and CreditBalanceCard
-- surface it); every write path is service-role. No write policies on purpose.
create policy yc_claims_select_member
  on public.yc_claims
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- ---------------------------------------------------------------------------
-- 3. The claim: yc_claims row + $326 grant in one transaction.

create function public.claim_yc_grant(in_org uuid, in_user uuid)
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
begin
  select * into org_row from public.organizations orgs where orgs.id = in_org;
  if not found then
    raise exception 'organization not found: %', in_org
      using errcode = 'P0002';
  end if;
  -- Claim once per org AND once per user. A retry after a committed-but-lost
  -- response (retryable transport error) must be idempotent: re-inserting hits
  -- a unique column, so on conflict we return the EXISTING claim and current
  -- balance instead of a bare 409, and never write a second ledger grant. Only
  -- a replay of the SAME (org, user) is idempotent; a PARTIAL conflict (this
  -- user already claimed a different org, or this org was claimed by another
  -- user) is a genuine collision and still surfaces as 23505 -> 409.
  insert into public.yc_claims
      (org_id, claimed_by, expires_at, billable_spend_at_claim_usd)
    values
      (in_org, in_user, now() + interval '3 months', org_row.billable_spend_usd)
    on conflict do nothing
    returning * into claim_row;
  if found then
    -- Fresh claim: apply the one-time $326 grant in the same transaction, so the
    -- claim row and its grant commit or roll back together.
    insert into public.credit_ledger
        (org_id, entry_type, amount_usd, reason, source, source_ref, created_by)
      values
        (in_org, 'grant', 326, 'YC launch grant', 'yc_launch', in_org::text, in_user::text);
  else
    -- Conflict: idempotent only when this exact (org, user) already holds it.
    select * into claim_row from public.yc_claims claims
      where claims.org_id = in_org and claims.claimed_by = in_user;
    if not found then
      raise exception 'yc grant already claimed for this org or user'
        using errcode = '23505';
    end if;
    -- Same (org, user) replay: the grant already committed alongside the claim
    -- row, so fall through and return it without a second grant.
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

-- ---------------------------------------------------------------------------
-- 4. Expiry: remove the unspent part of the grant, exactly once, never below
--    zero. clawback = LEAST(balance, GREATEST(0, 326 - spent_since_claim));
--    inserted only when positive, so an org that spent it all (or already
--    sits at/below zero) expires with no adjustment. The 'expiry:' || org_id
--    source_ref makes a rerun of the pass a no-op even if two workers race:
--    the unique (source, source_ref) index refuses the second insert.

create function public.process_yc_claim_expiries()
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
        326 - (claim.billable_spend_usd - claim.billable_spend_at_claim_usd)
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
