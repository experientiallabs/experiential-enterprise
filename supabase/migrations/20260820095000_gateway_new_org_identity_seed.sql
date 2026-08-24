-- New-org identity-tier seeding: give every NEWLY-created organization the same
-- deny-by-default starting position the P-A backfill gave every EXISTING org.
--
-- P-A (20260820090000) ran gateway_backfill_identity_tier() ONCE at migration
-- time: it created a default identity per org and seeded a grant for every
-- (default identity, alias) pair usable under the pre-cutover rule predicate.
-- That fixes existing orgs, but it does not fire for orgs created afterward. On
-- a deny-by-default tier (P-B enforces gateway_grants in the control store) a
-- brand-new org -- a real signup -- would land with a default identity and ZERO
-- grants, so it could not call even the PUBLIC catalog until something granted
-- it. That breaks "sign up -> immediately use public models", which was the
-- pre-identity-tier behavior (the public catalog was open to every org).
--
-- The fix is an INSERT path on organizations that, for each new org, (a) ensures
-- the default identity exists and (b) seeds grants for exactly the aliases
-- usable under P-A's rule predicate -- which, for a fresh org with no aliases of
-- its own yet, is precisely the PUBLIC catalog (active aliases with
-- org_id is null). A DB trigger is used rather than application code so it
-- covers EVERY insert path into organizations, including GoTrue's signup flow
-- (public.provision_signup_org inserts the personal org in a SECURITY DEFINER
-- trigger on auth.users) and the operator/seed paths, none of which route
-- through one shared application function.
--
-- The seed logic is the per-org projection of P-A's gateway_backfill_identity_tier:
-- the SAME 'org-' || org_id default-identity id and the SAME grant predicate
-- (aliases.active and (org_id is null or org_id = <org>)), so a new org's
-- starting grant set is identical to what the backfill would have produced.
-- Every write is ON CONFLICT DO NOTHING, so this composes with the P-A backfill
-- under any ordering and is safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Per-org seed. Idempotent, SECURITY DEFINER (writes the management tables
--    that revoke all from service_role; the runtime only reads them). Callable
--    directly so pgTAP can prove the seed against a single controlled org, and
--    invoked by the trigger below for the real insert paths. Keys are NOT
--    reparented here: a just-created org owns no api_keys yet, and the key-issue
--    API sets identity_id on mint. The predicate is byte-identical to P-A's
--    backfill so the two never diverge.

create function public.gateway_seed_org_identity_tier(p_org_id pg_catalog.uuid)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Default identity, id == the control store's synthetic 'org-' || org_id.
  insert into public.gateway_identities (identity_id, org_id, display_name)
    values ('org-' || p_org_id, p_org_id, 'Default')
  on conflict (identity_id) do nothing;

  -- Grant the default identity every alias usable under P-A's rule predicate:
  -- an active alias in this org's own namespace or the public catalog. For a
  -- fresh org this is exactly the public catalog, so a real signup can call
  -- public models immediately -- the pre-identity-tier behavior.
  insert into public.gateway_grants (org_id, identity_id, alias_id)
    select p_org_id, 'org-' || p_org_id, aliases.alias_id
      from public.gateway_aliases aliases
      where aliases.active
        and (aliases.org_id is null or aliases.org_id = p_org_id)
  on conflict do nothing;
end;
$$;

revoke all on function public.gateway_seed_org_identity_tier(pg_catalog.uuid)
  from public, anon, authenticated, service_role;

comment on function public.gateway_seed_org_identity_tier(pg_catalog.uuid) is
  'Per-org projection of gateway_backfill_identity_tier: default identity + deny-by-default grant seed matching P-A''s rule predicate (own-org + public active aliases). Idempotent; invoked by the organizations insert trigger so every new org starts able to call the public catalog.';

-- ---------------------------------------------------------------------------
-- 2. Trigger wrapper + AFTER INSERT trigger on organizations. Mirrors the
--    existing organizations_signup_promo pattern (credit_ledger migration):
--    AFTER INSERT ... FOR EACH ROW, SECURITY DEFINER, returns null. Firing on
--    the org table (not per-caller code) is what guarantees the signup flow and
--    every operator/seed path are covered by one seed.

create function public.gateway_new_org_identity_tier()
returns pg_catalog.trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_seed_org_identity_tier(new.id);
  return null;
end;
$$;

revoke all on function public.gateway_new_org_identity_tier()
  from public, anon, authenticated, service_role;

comment on function public.gateway_new_org_identity_tier() is
  'AFTER INSERT trigger on organizations: seeds the new org''s default identity and public-catalog grants so a fresh signup can call public models immediately (see gateway_seed_org_identity_tier).';

create trigger organizations_seed_identity_tier
  after insert on public.organizations
  for each row execute function public.gateway_new_org_identity_tier();

-- Sweep existing orgs at apply. P-A's backfill (20260820090000) ran when P-A
-- applied; but on a live database, orgs created BETWEEN P-A and this migration
-- have no identity/grants, and the trigger above only covers FUTURE inserts.
-- Re-run the idempotent backfill so EVERY existing org has its default identity
-- and public-catalog grants before P-B's deny-by-default enforcement can deny an
-- ungranted key. A no-op for already-seeded orgs (ON CONFLICT DO NOTHING); on a
-- fresh database this runs right after P-A's own backfill and grants nothing new.
select public.gateway_backfill_identity_tier();
