-- Per-organization enterprise entitlements (docs/enterprise.md §1).
--
-- The capability registry resolves in two tiers, matching the common
-- enterprise open-source split (GitLab .com-plan vs self-managed license,
-- PostHog cloud vs instance license):
--
--   1. HOSTED (multi-tenant): a row here grants ONE org one capability —
--      platform operators enable a paying enterprise account and nobody
--      else. The hosted deployment leaves the instance license unset, so
--      the average user sees nothing.
--   2. SELF-HOST / TRIAL (single-tenant): the instance-wide license seam
--      (EXPLABS_EE_CAPABILITIES today; the signed license token after the
--      /ee carve) enables capabilities for the whole install, which is one
--      customer by definition.
--
-- Absence of both means unlicensed, and unlicensed surfaces are ABSENT
-- (routes 404, no UI). Rows may carry an expiry for time-bound enterprise
-- pilots; an expired row is inert, never deleted by the read path.
--
-- Posture: newest era — RLS on with zero policies, revoke-all, service_role
-- DML only. The control API is the only writer (platform admins, audited).

create table public.org_entitlements (
  org_id      pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  capability  pg_catalog.text not null
    check (capability in ('audit_log', 'sso', 'scim', 'teams', 'data_controls')),
  granted_by  pg_catalog.uuid,
  note        pg_catalog.text
    check (note is null or pg_catalog.char_length(note) <= 512),
  created_at  pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at  pg_catalog.timestamptz,
  primary key (org_id, capability)
);

comment on table public.org_entitlements is
  'Per-org enterprise capability grants (hosted tier). Written only by the control API behind the platform-admin gate; every grant/revoke is an audit_log event. An unexpired row OR the instance license makes a capability available; neither means the surface is absent.';

alter table public.org_entitlements enable row level security;

revoke all on table public.org_entitlements
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.org_entitlements to service_role;
