-- Make the YC launch claim idempotent on the `yc` label (the "promotion
-- applied" marker), so the /yc path cannot grant a second time.
--
-- The original apply_yc_launch_grant only deduped on the grant's own
-- (source, source_ref) — its yc_launch row. That misses a real double-claim:
-- an org already credited by a DIFFERENT source (e.g. an operator backfill that
-- granted $526 as `admin` and applied the `yc` label) has the deal, but no
-- yc_launch row, so a later self-serve /yc claim granted a SECOND $526.
--
-- Fix: the `yc` label is the record that the YC promotion has been applied
-- (added whenever the credit is). The grant now runs ONLY when this call is the
-- one that newly applies the label; an org that already carries `yc` — from a
-- prior claim OR an operator backfill — gets no second grant. No bespoke
-- yc_claims table: the generalized org_labels IS the applied-promotion gate.

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
  label_newly_applied boolean := false;
  did_grant boolean := false;
  effective_expiry timestamptz := coalesce(
    in_expires_at, pg_catalog.now() + interval '3 months'
  );
begin
  select * into org_row from public.organizations orgs where orgs.id = in_org;
  if not found then
    raise exception 'organization not found: %', in_org using errcode = 'P0002';
  end if;

  -- Mark the org a YC company. This label is the "YC promotion applied" gate:
  -- FOUND is true only when THIS call inserted it (a first-ever tagging), false
  -- when the org already carried it (a prior claim or an operator backfill).
  insert into public.org_labels (org_id, key, created_by)
    values (in_org, 'yc', coalesce(in_created_by, '00000000-0000-0000-0000-000000000000'))
    on conflict (org_id, key) do nothing;
  label_newly_applied := found;

  -- Grant ONLY on the first-ever tagging. An org that already carries `yc` has
  -- the promotion applied and must not be credited again, whatever source paid
  -- for it — this is what stops the /yc path double-claiming.
  if label_newly_applied then
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
