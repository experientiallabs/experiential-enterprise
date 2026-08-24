-- Superadmin API keys: a MACHINE credential for platform operators, so the
-- admin API surface (/api/admin/* and every other control read a
-- platform-admin session can reach) is scriptable — promotions setup on a
-- never-seeded production, ops automation, agent-driven admin work.
--
-- Two-factor authority, checked at AUTH time on every request:
--   1. the presented `xpladmin_` secret must hash to a live (unrevoked) row
--      here, and
--   2. the row's OWNER must still be in public.platform_admins.
-- Removing an operator from platform_admins therefore kills all their keys
-- instantly, without a separate revocation sweep.
--
-- MINTING IS SESSION-ONLY by construction: rows are written by the web app's
-- platform-admin-gated admin routes over the service role; the FastAPI layer
-- only AUTHENTICATES these keys and exposes no mint/revoke route a key could
-- reach — a leaked superadmin key cannot create more superadmin keys.
--
-- Secret format mirrors customer keys (`xpl_` + 40 hex): `xpladmin_` + 40 hex
-- (160 random bits), stored only as its SHA-256 hex digest; the plaintext is
-- shown once at mint.

create table public.platform_admin_keys (
  id pg_catalog.uuid primary key default pg_catalog.gen_random_uuid(),
  -- The operator this key acts as; requests authenticate as this user with
  -- platform-admin authority. Deliberately NO foreign key to auth.users
  -- (house convention: GoTrue owns that table and it does not exist when
  -- migrations run on a fresh Docker stack) — same bare-uuid shape as
  -- platform_admins itself. Rows are AUDIT records and outlive their owner;
  -- the kill switch is removing the owner from platform_admins (or revoking
  -- the key), which auth re-checks on every request. Deleting the auth
  -- account alone does NOT kill keys — remove the platform_admins row.
  user_id pg_catalog.uuid not null,
  -- Durable attribution, captured from the minting session: survives the
  -- owner's account deletion so the audit trail always names a person.
  owner_email pg_catalog.text not null,
  name pg_catalog.text not null,
  -- Display recognition only (e.g. `xpladmin_ab12`); never enough to derive
  -- the secret.
  key_prefix pg_catalog.text not null,
  key_hash pg_catalog.text not null,
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  last_used_at pg_catalog.timestamptz,
  revoked_at pg_catalog.timestamptz
);

comment on table public.platform_admin_keys is
  'Superadmin machine credentials (xpladmin_ bearer). Authenticated by the control API middleware: live row + owner still in platform_admins = a platform-admin actor. Minted/revoked only by platform-admin SESSIONS through the web admin routes; the API layer never mints.';

create unique index platform_admin_keys_hash_key
  on public.platform_admin_keys (key_hash);
create index platform_admin_keys_user_idx
  on public.platform_admin_keys (user_id);

-- Service-role only: the web admin routes and the control API's auth lookup
-- both ride the service role; no end-user (RLS) path may read key hashes.
-- Revoke FIRST (house style): the stack's default privileges grant ALL to
-- service_role on new public tables, which would silently include DELETE and
-- falsify the rows-are-never-deleted audit invariant. Then grant exactly the
-- three verbs the mint/list/revoke/auth paths use.
alter table public.platform_admin_keys enable row level security;
revoke all on table public.platform_admin_keys
  from public, anon, authenticated, service_role;
grant select, insert, update on public.platform_admin_keys to service_role;
