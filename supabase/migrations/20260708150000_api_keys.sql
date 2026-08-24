-- Experiential Labs world-model platform schema: customer API keys.
--
-- An API key lets a customer's own code call the serving surface (world-model
-- reads, session create/step/transcript/usage) directly, without riding the
-- web app's session. Keys are org-scoped: the backend maps the presented
-- secret to its organization and serves only that organization's resources.
-- Only the SHA-256 hash of a secret is stored; the plaintext is shown once at
-- mint time. `key_prefix` keeps keys recognizable in the UI afterwards.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  -- First characters of the plaintext secret (e.g. `xpl_ab12cd34`), for
  -- display only; carries no secret material worth protecting.
  key_prefix text not null,
  -- SHA-256 hex digest of the full plaintext secret. Unique doubles as the
  -- lookup index for the backend's per-request resolution.
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_org_id_idx on public.api_keys (org_id);

alter table public.api_keys enable row level security;

-- Org members see their org's keys (metadata only from the UI's perspective;
-- the hash is not sensitive). Mint and revoke go through the web app's admin
-- API routes on the service role, which re-check org-admin membership.
create policy api_keys_select_member
  on public.api_keys
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

grant select on public.api_keys to authenticated;
grant select, insert, update, delete on public.api_keys to service_role;
