-- Tool accounts: spend-visibility-only vendor accounts an org tracks a credit
-- balance for on /credits, separate from the AI-callable model providers.
--
-- These are NOT inference providers: they never route through the gateway and
-- never enter the model catalog. They are the developer-tool accounts a team
-- funds alongside the platform (E2B for everyone; Greptile/Cursor/Devin for YC
-- companies, which is enforced by the API route against public.yc_claims). The
-- credits page shows a manual declared-balance drawdown for each, plus a
-- "Fetch balance" action backed by a pluggable balance fetcher (a deterministic
-- vendor billing API where one exists — Cursor's Admin API — otherwise a
-- computer-use agent that reads the vendor dashboard).
--
-- Sibling of provider_connections and trace_connections, not a new kind on
-- either: the consumers differ (spend visibility, not serving or ingest), the
-- vocabulary differs (tool vendors, not model providers), and the credential is
-- an optional DASHBOARD login rather than an inference key. The Vault shape is
-- identical on purpose: any credential lives only in Vault, entering through the
-- set RPC and leaving only through the release RPC at fetch time, both
-- service-role. Unlike provider_connections, vault_secret_id is NULLABLE: a row
-- can exist purely to track a self-declared balance (and E2B is read with the
-- platform's ambient E2B_API_KEY, never a per-org secret).

create table public.tool_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  vendor text not null check (vendor in ('e2b', 'greptile', 'cursor', 'devin')),
  -- Non-secret connection config (dashboard org handle, team id, ...); never
  -- the credential.
  config jsonb not null default '{}'::jsonb,
  -- The optional dashboard-login Vault secret. Null = no credential stored yet
  -- (E2B uses the platform's ambient key; a balance can still be self-declared).
  vault_secret_id uuid,
  credential_last4 text,
  -- The tracked remaining credit, exactly the provider_connections drawdown
  -- shape: customer-declared, or overwritten by a successful fetch. Remaining
  -- shown on /credits = declared_balance_usd (tool accounts have no gateway
  -- metering, so there is no metered_spend_usd drawdown here).
  declared_balance_usd numeric(14, 6) check (declared_balance_usd is null or declared_balance_usd >= 0),
  declared_balance_set_at timestamptz,
  -- How the current balance figure was produced.
  balance_source text check (balance_source in ('self_reported', 'vendor_api', 'computer_use')),
  low_balance_threshold_usd numeric(14, 6) not null default 5 check (low_balance_threshold_usd >= 0),
  -- The last fetch attempt's outcome, for the "Fetch balance" affordance.
  last_fetch_at timestamptz,
  last_fetch_status text check (last_fetch_status in ('reported', 'not_reportable', 'read_failed', 'pending')),
  last_fetch_message text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (org_id, vendor)
);

comment on table public.tool_accounts is
  'Spend-visibility-only vendor accounts (E2B, Greptile, Cursor, Devin) an org tracks a credit balance for on /credits; never AI-callable and never in the model catalog. Greptile/Cursor/Devin are gated to YC companies by the API route.';
comment on column public.tool_accounts.vault_secret_id is
  'Optional dashboard-login credential in Vault; null when none is stored (E2B uses the platform ambient key; a balance can still be self-declared).';
comment on column public.tool_accounts.declared_balance_usd is
  'Tracked remaining credit in USD: customer-declared, or overwritten by a successful balance fetch. Null = not tracked.';
comment on column public.tool_accounts.balance_source is
  'self_reported = the customer-declared gauge; vendor_api = a deterministic vendor billing API read; computer_use = a computer-use agent read of the vendor dashboard.';

create index tool_accounts_org_id_idx on public.tool_accounts (org_id);

alter table public.tool_accounts enable row level security;

create policy tool_accounts_select_member
  on public.tool_accounts
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- No write policies on purpose: rows are written only by the service role (the
-- tool-account API routes and the scheduled balance-fetch worker). The
-- credential never leaves Vault except through the release RPC below.

-- Store or rotate one tool account's dashboard-login credential (mirrors
-- upsert_provider_connection; creates the row if it does not exist yet so the
-- credential and the tracked balance can be set in either order).
create function public.set_tool_account_credential(
  in_org_id uuid,
  in_vendor text,
  in_config jsonb,
  in_secret text,
  in_actor text default null
)
returns table (
  id uuid,
  org_id uuid,
  vendor text,
  config jsonb,
  credential_last4 text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_vendor text := lower(nullif(btrim(in_vendor), ''));
  actor text := nullif(btrim(in_actor), '');
  existing_id uuid;
  existing_vault uuid;
  vault_secret uuid;
  vault_name text;
begin
  if normalized_vendor is null then
    raise exception 'vendor is required';
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'tool account credential is required';
  end if;
  -- credential_last4 is member-readable; a short secret would land in it whole.
  if length(in_secret) < 12 then
    raise exception 'tool account credential is too short to be a real credential';
  end if;
  if not exists (select 1 from public.organizations where organizations.id = in_org_id) then
    raise exception 'organization not found: %', in_org_id;
  end if;

  -- One statement inserts the row or, on the (org_id, vendor) conflict, locks
  -- the existing row (ON CONFLICT DO UPDATE takes a row-level lock) and returns
  -- it. A single upsert-returning is used INSTEAD of an insert-then-SELECT-FOR-
  -- UPDATE pair because that pair has a check-then-act window: a concurrent
  -- delete_tool_account could drop the row after the no-op insert but before the
  -- lock, leaving existing_id null so the code below creates a Vault secret and
  -- then updates nothing, orphaning the secret. After this statement the row
  -- provably exists and is locked to this transaction, so a concurrent delete
  -- serializes behind the commit and no secret can be orphaned. No Vault secret
  -- is created before the row is locked, so no losing writer can leak one.
  insert into public.tool_accounts (org_id, vendor, config, created_by, updated_by)
  values (in_org_id, normalized_vendor, coalesce(in_config, '{}'::jsonb), actor, actor)
  on conflict (org_id, vendor) do update set updated_at = now()
  returning tool_accounts.id, tool_accounts.vault_secret_id
  into existing_id, existing_vault;

  vault_name := format(
    'org:%s:tool-account:%s:%s',
    in_org_id::text,
    normalized_vendor,
    gen_random_uuid()::text
  );

  if existing_vault is null then
    vault_secret := vault.create_secret(in_secret, vault_name, normalized_vendor);
    update public.tool_accounts
    set
      config = coalesce(in_config, config),
      vault_secret_id = vault_secret,
      credential_last4 = right(in_secret, 4),
      updated_by = actor,
      updated_at = now()
    where tool_accounts.id = existing_id;
  else
    perform vault.update_secret(existing_vault, in_secret, vault_name, normalized_vendor);
    update public.tool_accounts
    set
      config = coalesce(in_config, config),
      credential_last4 = right(in_secret, 4),
      updated_by = actor,
      updated_at = now()
    where tool_accounts.id = existing_id;
  end if;

  return query
    select
      accounts.id,
      accounts.org_id,
      accounts.vendor,
      accounts.config,
      accounts.credential_last4
    from public.tool_accounts accounts
    where accounts.id = existing_id;
end;
$$;

revoke all on function public.set_tool_account_credential(uuid, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.set_tool_account_credential(uuid, text, jsonb, text, text)
  to service_role;

-- Decrypt one tool account's dashboard credential for a balance fetch. A
-- management-plane read (never serving), so it stamps last_used_at like the
-- provider serving release does for a clear "last touched" trace.
create function public.release_tool_account_credential(in_account_id uuid)
returns table (credential text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_vault uuid;
  released text;
begin
  -- Lock the account row for the release so a concurrent delete_tool_account
  -- serializes behind this transaction: the delete cannot drop the row and its
  -- Vault secret between this read and the decrypt below, so the secret is
  -- never removed mid-release nor handed out for a row that is being deleted.
  select accounts.vault_secret_id
  into target_vault
  from public.tool_accounts accounts
  where accounts.id = in_account_id
  for update;

  if target_vault is null then
    raise exception 'tool account has no stored credential: %', in_account_id;
  end if;

  select decrypted_secret
  into released
  from vault.decrypted_secrets
  where vault.decrypted_secrets.id = target_vault;

  if released is null then
    raise exception 'tool account credential is not decryptable: %', in_account_id;
  end if;

  update public.tool_accounts
  set last_used_at = now()
  where tool_accounts.id = in_account_id;

  return query select released;
end;
$$;

revoke all on function public.release_tool_account_credential(uuid)
  from public, anon, authenticated;
grant execute on function public.release_tool_account_credential(uuid)
  to service_role;

-- Disconnect: drop the row AND its Vault secret (when one exists).
create function public.delete_tool_account(in_org_id uuid, in_vendor text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_vendor text := lower(nullif(btrim(in_vendor), ''));
  target_id uuid;
  target_vault uuid;
begin
  -- Lock the row so a concurrent credential save (which locks before attaching
  -- its Vault secret) is serialized against this delete: without FOR UPDATE the
  -- delete could snapshot a stale null vault_secret_id and orphan a
  -- just-attached secret. Serializing makes cleanup see the committed pointer.
  select accounts.id, accounts.vault_secret_id
  into target_id, target_vault
  from public.tool_accounts accounts
  where accounts.org_id = in_org_id
    and accounts.vendor = normalized_vendor
  limit 1
  for update;

  if target_id is null then
    return false;
  end if;

  delete from public.tool_accounts where tool_accounts.id = target_id;
  if target_vault is not null then
    delete from vault.secrets where vault.secrets.id = target_vault;
  end if;
  return true;
end;
$$;

revoke all on function public.delete_tool_account(uuid, text)
  from public, anon, authenticated;
grant execute on function public.delete_tool_account(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Scheduled balance fetch: a nightly pg_cron tick that refreshes every
-- connected account's remaining balance so /credits stays fresh without a user
-- clicking "Fetch balance". Mirrors invoke_daily_summary exactly — reads the
-- target URL and the shared cron bearer from Vault, exits silently when either
-- is absent (local-dev safety), and only queues the POST (pg_net sends after
-- commit). The route it calls is the CRON_SECRET-gated internal balance-fetch
-- endpoint on the WEB service (like daily-summary/spend-alerts/auto-recharge),
-- which proxies to the deployment-keyed backend worker that runs the
-- per-provider staleness-floored reads and persists snapshots. The deploy sets
-- the 'balance_fetch_url' Vault secret the same way it sets 'daily_summary_url'.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end;
$$;

create or replace function public.invoke_balance_fetch()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  fetch_url text;
  bearer_secret text;
begin
  select secrets.decrypted_secret into fetch_url
  from vault.decrypted_secrets secrets
  where secrets.name = 'balance_fetch_url';
  select secrets.decrypted_secret into bearer_secret
  from vault.decrypted_secrets secrets
  where secrets.name = 'cron_secret';
  if fetch_url is null or bearer_secret is null then
    return;
  end if;
  perform net.http_post(
    url := fetch_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || bearer_secret
    )
  );
end;
$$;

revoke all on function public.invoke_balance_fetch()
  from public, anon, authenticated;

do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; account-balance-fetch schedule not attached';
    return;
  end if;
  -- 04:30 UTC nightly, offset from the 05:00 daily digest so the two cron
  -- ticks do not contend. cron.schedule upserts by name, so redeploys never
  -- duplicate the job.
  perform cron.schedule(
    'account-balance-fetch',
    '30 4 * * *',
    'select public.invoke_balance_fetch()'
  );
end;
$$;
