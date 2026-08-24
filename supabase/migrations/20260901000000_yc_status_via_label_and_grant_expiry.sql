-- Collapse YC-company status off the bespoke `yc_claims` table onto the
-- generalized `yc` org label, and generalize grant expiry onto credit_ledger.
--
-- New model (the product owner, 2026-09-01):
--   * "YC company" == the org carries the generalized `yc` label (public.org_labels).
--     All gating (the Greptile/Cursor/Devin tool deals, the budget block, the
--     dashboard badge) reads the label; there is no separate yc_claims row.
--   * The launch credit is a plain credit_ledger grant (source 'yc_launch')
--     that carries its OWN expiry and spend snapshot, so ANY grant can expire,
--     not just YC. A daily pass claws back the unspent part at expiry.
--   * Admins apply the label and set the grant amount + expiry from the admin
--     panel; the /yc funnel does the same thing self-serve with the launch
--     defaults ($526, 3 months).
--
-- yc_claims, claim_yc_grant, and process_yc_claim_expiries are removed at the
-- end, AFTER their data is migrated onto the label + the generalized grant.

-- ---------------------------------------------------------------------------
-- 1. Generalize grant expiry on credit_ledger.

-- credit_ledger is APPEND-ONLY (credit_ledger_append_only blocks UPDATE/DELETE),
-- so both new columns are set at INSERT and never updated. "Already clawed back"
-- is not a column — it is the existence of the grant's own 'grant-expiry:<id>'
-- adjustment row (append-only idempotency), so no expiry_processed_at flag.
alter table public.credit_ledger
  add column if not exists expires_at timestamptz,
  add column if not exists billable_spend_at_grant_usd numeric(14, 6);

comment on column public.credit_ledger.expires_at is
  'When this grant expires; the daily process_expiring_grants pass appends a clawback of its unspent part. NULL = never expires.';
comment on column public.credit_ledger.billable_spend_at_grant_usd is
  'organizations.billable_spend_usd at grant time; the expiry clawback removes only amount_usd - (billable_spend_usd - this), i.e. the part of the grant that went unspent.';

-- ---------------------------------------------------------------------------
-- 2. The generalized expiry clawback (replaces process_yc_claim_expiries).
--    "At expiry an adjustment removes the UNSPENT part of the grant, never
--    pushing the balance negative, idempotent on rerun." credit_ledger is
--    APPEND-ONLY, so this never UPDATEs a grant: a grant is "already handled"
--    when its own 'grant-expiry:<id>' adjustment exists. A fully-spent expired
--    grant (clawback 0) writes nothing and is simply re-evaluated as a harmless
--    no-op on later passes (unspent only shrinks once expired).

create or replace function public.process_expiring_grants()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  processed integer := 0;
  g record;
  billable_now numeric;
  balance numeric;
  unspent numeric;
  clawback numeric;
begin
  for g in
    select ledger.id, ledger.org_id, ledger.amount_usd,
           ledger.billable_spend_at_grant_usd
      from public.credit_ledger ledger
     where ledger.entry_type = 'grant'
       and ledger.expires_at is not null
       and ledger.expires_at <= pg_catalog.now()
       and not exists (
         select 1 from public.credit_ledger done
          where done.source = 'yc_launch'
            and done.source_ref = 'grant-expiry:' || ledger.id
       )
  loop
    select orgs.billable_spend_usd,
           orgs.credit_granted_usd - orgs.billable_spend_usd
      into billable_now, balance
      from public.organizations orgs
     where orgs.id = g.org_id;
    -- Unspent part of THIS grant = amount minus spend since it was granted,
    -- floored at 0. Spend-since = billable_spend_usd now minus the snapshot.
    unspent := greatest(
      0, g.amount_usd - (billable_now - coalesce(g.billable_spend_at_grant_usd, 0))
    );
    -- Never push the balance negative: claw back at most the live balance.
    clawback := least(unspent, greatest(0, balance));
    if clawback > 0 then
      insert into public.credit_ledger
          (org_id, entry_type, amount_usd, reason, source, source_ref, created_by)
        values
          (g.org_id, 'adjustment', -clawback,
           'Expired grant clawback (unspent portion)', 'yc_launch',
           'grant-expiry:' || g.id, null)
        on conflict (source, source_ref) where source_ref is not null do nothing;
      processed := processed + 1;
    end if;
  end loop;
  return processed;
end;
$$;

revoke all on function public.process_expiring_grants() from public, anon, authenticated;
grant execute on function public.process_expiring_grants() to service_role;

-- ---------------------------------------------------------------------------
-- 3. The generalized launch grant: apply the `yc` label + a grant carrying its
--    own amount and expiry, folding the $20 welcome promo in. Idempotent per
--    org via the (source, source_ref) unique index and the label's unique
--    (org_id, key). The /yc funnel calls this with the launch defaults; the
--    admin panel calls it with an explicit amount and expiry.

create or replace function public.apply_yc_launch_grant(
  in_org uuid,
  in_amount numeric,
  in_expires_at timestamptz,
  in_created_by uuid
)
returns table (
  granted_usd numeric,
  expires_at timestamptz,
  balance_usd numeric,
  org_slug text,
  org_name text,
  newly_applied boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  org_row public.organizations%rowtype;
  promo_granted numeric;
  did_grant boolean := false;
  effective_expiry timestamptz := coalesce(
    in_expires_at, pg_catalog.now() + interval '3 months'
  );
begin
  select * into org_row from public.organizations orgs where orgs.id = in_org;
  if not found then
    raise exception 'organization not found: %', in_org using errcode = 'P0002';
  end if;

  -- Mark the org a YC company (the generalized label is the gate). The all-zero
  -- uuid means "applied by the system" when no admin is named.
  insert into public.org_labels (org_id, key, created_by)
    values (in_org, 'yc', coalesce(in_created_by, '00000000-0000-0000-0000-000000000000'))
    on conflict (org_id, key) do nothing;

  -- The launch grant: one per org (source_ref = the org), carrying its expiry
  -- and the spend snapshot the clawback needs. A replay is a no-op.
  insert into public.credit_ledger
      (org_id, entry_type, amount_usd, reason, source, source_ref, created_by,
       expires_at, billable_spend_at_grant_usd)
    values
      (in_org, 'grant', in_amount, 'YC launch grant', 'yc_launch',
       'yc-launch:' || in_org, in_created_by::text,
       effective_expiry, org_row.billable_spend_usd)
    on conflict (source, source_ref) where source_ref is not null do nothing;
  did_grant := found;

  if did_grant then
    -- Fold the $20 welcome promo into the launch grant (once).
    select coalesce(pg_catalog.sum(ledger.amount_usd), 0)
      into promo_granted
      from public.credit_ledger ledger
     where ledger.org_id = in_org and ledger.source = 'signup_promo';
    if promo_granted > 0 then
      insert into public.credit_ledger
          (org_id, entry_type, amount_usd, reason, source, source_ref, created_by)
        values
          (in_org, 'adjustment', -promo_granted,
           'Welcome credit folded into the YC launch grant', 'yc_launch',
           'promo-reversal:' || in_org, in_created_by::text)
        on conflict (source, source_ref) where source_ref is not null do nothing;
    end if;
  end if;

  return query
  select
    in_amount,
    effective_expiry,
    orgs.credit_granted_usd - orgs.billable_spend_usd,
    orgs.slug,
    orgs.name,
    did_grant
  from public.organizations orgs
  where orgs.id = in_org;
end;
$$;

revoke all on function public.apply_yc_launch_grant(uuid, numeric, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.apply_yc_launch_grant(uuid, numeric, timestamptz, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Migrate existing claims onto the label + stamp their grants' expiry, so
--    every founder who already claimed keeps YC status and their existing
--    grant expires exactly when their claim would have.

-- Every claimed org gets the label (YC status persists even after the grant
-- lapses, matching the old "keeps its tool-account cards" behavior).
insert into public.org_labels (org_id, key, created_by)
  select yc.org_id, 'yc', yc.claimed_by
    from public.yc_claims yc
  on conflict (org_id, key) do nothing;

-- Stamp expiry + spend snapshot onto each existing launch grant. This is a
-- one-time backfill UPDATE, which credit_ledger's append-only trigger forbids
-- at runtime, so disable it for just this statement (superuser DDL, atomic in
-- the migration transaction). Only claims NOT already expiry-processed are
-- stamped: an already-clawed-back grant keeps expires_at NULL so the new
-- append-only pass never re-claws it (its old clawback adjustment already ran).
alter table public.credit_ledger disable trigger credit_ledger_append_only;
update public.credit_ledger ledger
   set expires_at = yc.expires_at,
       billable_spend_at_grant_usd = yc.billable_spend_at_claim_usd
  from public.yc_claims yc
 where ledger.org_id = yc.org_id
   and ledger.source = 'yc_launch'
   and ledger.entry_type = 'grant'
   and yc.expiry_processed_at is null
   and yc.revoked_at is null;
alter table public.credit_ledger enable trigger credit_ledger_append_only;

-- ---------------------------------------------------------------------------
-- 4b. Let members read their own org's `yc` label (and only that label), so the
--     member-facing YC badge/gating that used to read yc_claims keeps working.
--     org_labels is otherwise admin-only; this exposes the YC designation the
--     founder already sees, and nothing else (no other internal label leaks).

create policy org_labels_select_yc_member
  on public.org_labels
  for select
  to authenticated
  using (key = 'yc' and org_id in (select public.member_org_ids()));

-- ---------------------------------------------------------------------------
-- 4c. Re-point the serving refusal's YC suffix off yc_claims onto the launch
--     grant. The friendly "you're on the YC launch grant" line shows while the
--     org holds an UNEXPIRED yc_launch grant (the same semantics the old
--     unexpired-claim read had), sourced now from credit_ledger.

create or replace function public.gateway_org_yc_suffix(p_org_id pg_catalog.uuid)
returns pg_catalog.text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_active pg_catalog.bool;
begin
  select pg_catalog.count(*) > 0
    into v_active
    from public.credit_ledger ledger
   where ledger.org_id = p_org_id
     and ledger.source = 'yc_launch'
     and ledger.entry_type = 'grant'
     and ledger.expires_at is not null
     and ledger.expires_at > pg_catalog.clock_timestamp();
  if v_active then
    return ' You''re on the YC launch grant — text/call the product owner at '
      || public.gateway_support_phone()
      || ' or email ' || public.gateway_support_email()
      || ' and he''ll sort you out.';
  end if;
  return '';
end;
$$;

revoke all on function public.gateway_org_yc_suffix(pg_catalog.uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Remove the bespoke YC machinery now that its data lives on the label and
--    the generalized grant.

drop function if exists public.claim_yc_grant(uuid, uuid);
drop function if exists public.process_yc_claim_expiries();
drop table if exists public.yc_claims cascade;
