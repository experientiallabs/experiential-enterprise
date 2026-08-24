-- Device-code account creation: the OAuth device-authorization grant a
-- coding agent uses to create an account and receive a working API key without
-- driving a browser itself (like `gh auth login`).
--
-- The agent calls POST /api/signup/device/start (public) and receives a
-- high-entropy device_code plus a short human user_code. The founder opens the
-- verification URI in a browser, authenticates through the EXISTING Supabase
-- auth (which provisions their org and the standard $20 welcome grant via the
-- signup triggers), and approves the user_code. The web app mints one org API
-- key and stashes it on the row; the agent's next poll redeems it exactly once.
--
-- Only the SHA-256 hash of the device_code is stored, never the plaintext. The
-- minted key secret rides `api_key_secret` transiently between approval and the
-- one redeeming poll, then is nulled in the same guarded update — the row never
-- retains recoverable key material after redemption. The table is service-role
-- only: RLS is enabled with no authenticated policy, so the backend (device
-- start/poll) and the web app (approval) reach it through the service role and
-- nothing else can. Rows are short-lived (expires_at, default ~10 minutes) and
-- an expired row can never be redeemed.

create table public.device_authorizations (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 hex digest of the plaintext device_code; unique doubles as the
  -- backend's per-poll lookup index. The plaintext is returned once at start.
  device_code_hash text not null unique check (device_code_hash ~ '^[0-9a-f]{64}$'),
  -- Short human-typable code the founder confirms in the browser (e.g.
  -- WDJB-MJHT). Unique so the approval page can resolve it without the
  -- device_code, which only the agent holds.
  user_code text not null unique check (length(user_code) between 4 and 32),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'redeemed')),
  -- Set at approval time from the founder's authenticated session.
  org_id uuid references public.organizations(id) on delete cascade,
  approved_by uuid,
  api_key_id uuid references public.api_keys(id) on delete set null,
  -- Transient plaintext of the minted key: written at approval, returned by the
  -- single redeeming poll, then nulled in the same update. Never retained.
  api_key_secret text,
  credits_granted_usd numeric(12, 2),
  overview_url text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  redeemed_at timestamptz,
  -- Last poll timestamp, so the backend can answer slow_down when an agent
  -- polls faster than the advertised interval (enforced across replicas).
  last_polled_at timestamptz
);

-- Sweep index for the expiry pass; the two natural keys are already unique.
create index device_authorizations_expires_at_idx
  on public.device_authorizations (expires_at);

alter table public.device_authorizations enable row level security;

-- No authenticated/anon policy on purpose: this row carries the transient key
-- secret and the pending-approval state, so it is reachable only through the
-- service role (the FastAPI device endpoints and the web approval handler).
grant select, insert, update, delete on public.device_authorizations to service_role;

-- Idempotent expiry sweep: delete rows past their TTL that were never redeemed.
-- Deleting rather than tombstoning keeps the transient key secret from lingering
-- on an unredeemed, expired authorization. Returns the number of rows removed.
create or replace function public.expire_device_authorizations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  with deleted as (
    delete from public.device_authorizations
    where expires_at < now()
      and status <> 'redeemed'
    returning 1
  )
  select count(*) into removed from deleted;
  return removed;
end;
$$;

revoke all on function public.expire_device_authorizations()
  from public, anon, authenticated;
grant execute on function public.expire_device_authorizations() to service_role;
