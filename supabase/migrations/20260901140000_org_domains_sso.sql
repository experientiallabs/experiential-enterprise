-- E2 SSO substrate: converge onto the EXISTING public.org_domains
-- (20260822180000_org_domain_join_requests.sql) instead of creating a
-- parallel table. That migration shipped operator-controlled domain -> org
-- associations for join requests and deliberately refused org-admin
-- self-assertion (a tenant claiming '@gmail.com' would vacuum up signups).
-- DNS-TXT VERIFICATION is exactly the safe self-service mechanism that
-- design left room for: an org admin may now claim a domain, but the claim
-- does nothing (no join offers, no SSO) until a real DNS lookup proves
-- control of _explabs-verify.<domain>.
--
-- Additions, all nullable/defaulted so existing rows and writers are
-- untouched:
--   * verification_token -- server-generated TXT challenge; NULL on
--     operator-asserted rows, which never carried one.
--   * verified_at        -- proof timestamp. Existing operator rows are
--     backfilled as verified at their creation time: they were asserted by
--     platform operators and already drive join offers.
--   * sso_required       -- only a VERIFIED domain may require SSO (CHECK),
--     so an unverified claim can never lock an org out.
--
-- The table keeps its original posture (RLS with the admin-read policy,
-- authenticated SELECT, service_role DML) and its GLOBAL unique(domain)
-- index -- one claim per domain deployment-wide, unverified included. A
-- squatter claim on someone else's domain therefore blocks the owner's
-- claim until a platform operator deletes it; that dispute path is
-- deliberate (operators already own domain associations here) and the
-- claim itself grants nothing while unverified.

alter table public.org_domains
  add column verification_token pg_catalog.text
    check (
      verification_token is null
      or pg_catalog.char_length(verification_token) between 20 and 128
    ),
  add column verified_at pg_catalog.timestamptz,
  add column sso_required pg_catalog.bool not null default false;

alter table public.org_domains
  add constraint org_domains_sso_requires_verified
    check (not sso_required or verified_at is not null);

-- Operator-asserted rows predate verification and are trusted: they were
-- created by platform admins and already back the join-offer path.
update public.org_domains
   set verified_at = created_at
 where verified_at is null;

comment on column public.org_domains.verification_token is
  'Server-generated DNS-TXT challenge for org-admin self-service claims (published at _explabs-verify.<domain>); NULL on operator-asserted rows.';
comment on column public.org_domains.verified_at is
  'When control of the domain was proved (DNS TXT match) or the row was operator-asserted (backfilled to created_at). NULL = unverified claim: no join offers, no SSO.';
comment on column public.org_domains.sso_required is
  'Members of this org must authenticate through the org IdP (E2 org-access gate). CHECK-bound to verified rows only.';

-- ---------------------------------------------------------------------------
-- The web org-access gate's one read: does this org require SSO? Definer and
-- authenticated-callable on purpose — the flag is enumerated carve-out
-- metadata (a member must be able to learn the org requires step-up), while
-- the table itself stays unreadable to browser roles.

create function public.org_sso_required(in_org_id pg_catalog.uuid)
returns pg_catalog.bool
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.org_domains domains
     where domains.org_id = in_org_id
       and domains.sso_required
       and domains.verified_at is not null
  );
$$;

revoke all on function public.org_sso_required(pg_catalog.uuid)
  from public, anon;
grant execute on function public.org_sso_required(pg_catalog.uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Batched variant for the org switcher's "SSO" tag: which of THESE orgs
-- require SSO. Scoped to the caller-supplied id set so it never enumerates
-- SSO orgs deployment-wide; callers pass the orgs their session already sees.

create function public.sso_required_org_ids(in_org_ids pg_catalog.uuid[])
returns setof pg_catalog.uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct domains.org_id
    from public.org_domains domains
   where domains.org_id = any (in_org_ids)
     and domains.sso_required
     and domains.verified_at is not null;
$$;

revoke all on function public.sso_required_org_ids(pg_catalog.uuid[])
  from public, anon;
grant execute on function public.sso_required_org_ids(pg_catalog.uuid[])
  to authenticated, service_role;
