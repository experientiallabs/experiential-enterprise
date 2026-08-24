-- Gateway identity tier: identities, deny-by-default grants, and monthly
-- budgets, plus a behavior-preserving cutover of today's synthetic
-- org->identity auth mapping onto real rows.
--
-- This migration is ADDITIVE and INERT to the current request hot path. The
-- int-p2 control store still synthesizes identity_id = 'org-{org_id}' and still
-- derives grants from the rule predicate (gateway_aliases.active AND
-- (org_id is null OR org_id = caller org)); nothing here is read by that path
-- yet. P-B swaps the control store onto gateway_grants; P-C swaps the
-- reservation seam onto gateway_budgets. The single job of this migration is to
-- leave those two later swaps behavior-preserving:
--
--   * one default identity PER org whose identity_id is EXACTLY today's
--     synthetic 'org-' || org_id (control_store.py organization_artifact_id),
--     so P-B's real keys.identity_id equals the value P-B replaces;
--   * every existing api_keys row reparented to its org's default identity;
--   * a grant seeded for every (default identity, alias) pair usable today, so
--     deny-by-default removes NO access that works now (the cutover invariant).
--
-- Shapes mirror WMO's already-shipped contracts
-- (wmo/runtime/gateway/platform.py: IdentityRecord, GrantRecord,
-- MonthlyBudgetRecord/MonthlyBudgetScope) so a later switch to the full
-- platform factory is a drop-in. Ordered after int-p1's gateway_runtime
-- (20260819190000) and int-p2's route-context/protocol-state migrations; the
-- additive ALTERs on api_keys and gateway_aliases are new-file-only, so they do
-- not textually touch int-p1's migration.

-- ---------------------------------------------------------------------------
-- 1. Identities. One non-secret principal owned by an organization
--    (WMO IdentityRecord). identity_id is text, not uuid, because
--    WMO IdentityId = ArtifactId and the default identity's id must equal
--    today's synthetic 'org-' || org_id string, which starts with a letter and
--    matches the ArtifactId pattern used by the control store
--    (control_store.py _ARTIFACT_ID_PATTERN).

create table public.gateway_identities (
  identity_id  pg_catalog.text primary key
    check (identity_id ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'),
  org_id       pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  display_name pg_catalog.text not null
    check (pg_catalog.char_length(display_name) between 1 and 256),
  description  pg_catalog.text
    check (description is null or pg_catalog.char_length(description) <= 2048),
  active       pg_catalog.bool not null default true,
  created_at   pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at   pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  unique (org_id, identity_id)
);

comment on table public.gateway_identities is
  'Non-secret principals owned by an organization (WMO IdentityRecord). Every org has a default identity with id ''org-'' || org_id that mirrors the control store''s synthetic org->identity mapping; api_keys hang off an identity via api_keys.identity_id.';

-- ---------------------------------------------------------------------------
-- 2. Reparent keys onto identities. Additive, nullable, backfilled below.
--    The int-p1 SQL write paths read api_keys only by id/org_id/revoked_at/
--    expires_at (gateway_accept_request, gateway_start_attempt), so adding a
--    column cannot perturb accept/reserve/settle. The column stays nullable at
--    the DB level (a key whose identity row is gone must not wedge auth);
--    the issue API enforces non-null. No ON DELETE action (NO ACTION): an
--    identity with attached keys cannot be dropped out from under them, while
--    the org-deletion cascade still clears keys and identities together in one
--    statement.

alter table public.api_keys
  add column identity_id pg_catalog.text
    references public.gateway_identities(identity_id);

-- ---------------------------------------------------------------------------
-- 3. Named-alias marker so catalog rebuilds skip admin-managed aliases.
--    Purely additive; every existing row defaults to 'catalog'. The catalog
--    builder only touches origin='catalog' rows; P-E creates origin='named'.

alter table public.gateway_aliases
  add column origin pg_catalog.text not null default 'catalog'
    check (origin in ('catalog', 'named'));

-- ---------------------------------------------------------------------------
-- 4. Grants (deny-by-default). One explicit identity-to-alias authorization
--    (WMO GrantRecord). alias_id is the stable key; the store projects
--    alias_name by joining gateway_aliases at read. No grant row for a
--    (identity, alias) pair means no access -- which is why the backfill below
--    is load-bearing, not cosmetic.

create table public.gateway_grants (
  org_id      pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  identity_id pg_catalog.text not null
    references public.gateway_identities(identity_id) on delete cascade,
  alias_id    pg_catalog.text not null
    references public.gateway_aliases(alias_id) on delete cascade,
  created_at  pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (identity_id, alias_id)
);

comment on table public.gateway_grants is
  'Explicit identity-to-alias authorizations (WMO GrantRecord), deny-by-default. P-B joins this in PostgresGatewayControlStore.authorize_request/granted_aliases keyed on api_keys.identity_id. Seeded at migration time so every alias usable under the pre-cutover rule predicate stays usable.';

-- ---------------------------------------------------------------------------
-- 5. Monthly budgets (WMO MonthlyBudgetRecord + MonthlyBudgetScope). Store the
--    limit + scope only; reserved/settled/remaining are derived at read from
--    gateway_attempts, never a second source of truth for spent money. Absence
--    of a row means "unlimited", which is today's behavior, so there is no
--    behavior-preserving backfill for budgets.

create table public.gateway_budgets (
  budget_id     pg_catalog.text primary key
    check (pg_catalog.char_length(budget_id) between 1 and 128),
  org_id        pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  period        pg_catalog.text not null
    check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  scope_kind    pg_catalog.text not null
    check (scope_kind in ('team', 'identity', 'pool', 'deployment')),
  identity_id   pg_catalog.text
    references public.gateway_identities(identity_id) on delete cascade,
  alias_id      pg_catalog.text
    references public.gateway_aliases(alias_id) on delete cascade,
  pool_id       pg_catalog.text,
  deployment_id pg_catalog.text,
  limit_micro_usd pg_catalog.int8 not null check (limit_micro_usd >= 0),
  created_at    pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at    pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  -- Exactly the identifiers owned by the selected scope, matching
  -- MonthlyBudgetScope._require_scope_shape (platform.py):
  --   team:(none) identity:(identity_id) pool:(alias_id,pool_id)
  --   deployment:(alias_id,pool_id,deployment_id).
  check (
    (scope_kind = 'team'       and identity_id is null and alias_id is null
       and pool_id is null and deployment_id is null) or
    (scope_kind = 'identity'   and identity_id is not null and alias_id is null
       and pool_id is null and deployment_id is null) or
    (scope_kind = 'pool'       and alias_id is not null and pool_id is not null
       and identity_id is null and deployment_id is null) or
    (scope_kind = 'deployment' and alias_id is not null and pool_id is not null
       and deployment_id is not null and identity_id is null)
  )
);

-- One budget row per (org, period, scope). A table-level UNIQUE cannot carry
-- expressions, so the nullable scope identifiers are coalesced in a unique
-- index instead; '' is never a valid identifier, so it is a safe null stand-in
-- purely for uniqueness.
create unique index gateway_budgets_scope_uniq
  on public.gateway_budgets (
    org_id, period, scope_kind,
    coalesce(identity_id, ''), coalesce(alias_id, ''),
    coalesce(pool_id, ''), coalesce(deployment_id, '')
  );

comment on table public.gateway_budgets is
  'Monthly hard-limit scopes (WMO MonthlyBudgetRecord). Stores limit + scope only; balances derive from gateway_attempts at read. Absence of a row = unlimited (today''s behavior). P-C reads this at the reservation seam.';

-- ---------------------------------------------------------------------------
-- 6. Behavior-preserving backfill, as an idempotent function so the exact seed
--    logic the migration runs is provable by pgTAP against controlled fixtures
--    (the migration runs on an empty database, where the backfill is a no-op).
--    Superuser/migration-only: every write path here is service-role-invisible.

create function public.gateway_backfill_identity_tier()
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- One default identity per org, id == today's synthetic 'org-' || org_id.
  insert into public.gateway_identities (identity_id, org_id, display_name)
    select 'org-' || orgs.id, orgs.id, 'Default'
      from public.organizations orgs
  on conflict (identity_id) do nothing;

  -- Reparent every not-yet-parented key onto its org's default identity. This
  -- is exactly the value the control store synthesizes today, so P-B reading
  -- keys.identity_id sees an identical result for existing keys.
  update public.api_keys keys
     set identity_id = 'org-' || keys.org_id
   where keys.identity_id is null;

  -- Seed a grant for every (default identity, alias) pair usable today under
  -- the rule predicate: an active alias in the org's own namespace or the
  -- public catalog. Without this, deny-by-default silently kills all existing
  -- traffic on P-B cutover.
  insert into public.gateway_grants (org_id, identity_id, alias_id)
    select orgs.id, 'org-' || orgs.id, aliases.alias_id
      from public.organizations orgs
      join public.gateway_aliases aliases
        on aliases.active
       and (aliases.org_id is null or aliases.org_id = orgs.id)
  on conflict do nothing;
end;
$$;

revoke all on function public.gateway_backfill_identity_tier()
  from public, anon, authenticated, service_role;

comment on function public.gateway_backfill_identity_tier() is
  'Idempotent cutover backfill: default identity per org, key reparent, and deny-by-default grant seed matching the pre-cutover rule predicate. Invoked once by this migration; re-run safe. Proven by the cutover-preservation pgTAP suite.';

select public.gateway_backfill_identity_tier();

-- ---------------------------------------------------------------------------
-- 7. Row security and grants. Mirror gateway_key_limits: these are
--    control-API-owned management tables with no gateway runtime invariant
--    behind their writes (the runtime only READS grants/budgets, as postgres,
--    which bypasses RLS). The management API (P-D) writes them as service_role;
--    the reparent column and origin column inherit their tables' grants.

alter table public.gateway_identities enable row level security;
alter table public.gateway_grants enable row level security;
alter table public.gateway_budgets enable row level security;

revoke all on table public.gateway_identities
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_grants
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_budgets
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.gateway_identities to service_role;
grant select, insert, update, delete on table public.gateway_grants to service_role;
grant select, insert, update, delete on table public.gateway_budgets to service_role;
