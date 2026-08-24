-- ---------------------------------------------------------------------------
-- Decouple the credit SPEND gate from LOGIN (the product owner, 2026-08-26).
--
-- Product requirement (founder, verbatim): "Using the credits should just be
-- gated, not authentication or getting the credits." A new user must be LOGGED
-- IN immediately at signup and SEE their $20; only SPENDING those credits is
-- gated until they prove inbox ownership by clicking the emailed link.
--
-- The bug this fixes: the P1025 spend gate was keyed on
-- auth.users.email_confirmed_at, which is ALSO the flag GoTrue uses to permit
-- password sign-in. To keep the account spend-gated the instant paths created it
-- UNCONFIRMED (email_confirm:false), but then GoTrue REFUSES signInWithPassword
-- for an unconfirmed email ("email_not_confirmed") even under
-- mailer_autoconfirm, so the BROWSER /signup user was never actually logged in.
-- Login and spend-unlock were conflated in one column.
--
-- The fix: a SEPARATE per-org "spend unlocked" signal, public.organizations
-- .spend_unlocked_at (NULL = spend gated). Signup now sets email_confirm:true
-- so the session mints and the user is logged in immediately; spend_unlocked_at
-- stays NULL so credits are still locked. Clicking the verification link (proof
-- of inbox ownership) sets spend_unlocked_at, which both opens the gate and
-- fires credential rotation. email_confirmed_at goes back to meaning exactly
-- what GoTrue means by it (login permitted) and nothing more.
--
-- Column placement: organizations. The gate is per-ORG (it refuses host-lane /
-- platform-funded reservations for an org), enforced inside gateway_start_attempt
-- which already takes the organizations row lock; the credit balance, daily
-- caps, and grant all live on organizations. Keeping the unlock instant on the
-- same row means the gate reads one already-locked row instead of joining out to
-- auth.users on every reservation. The founding-admin membership is still what
-- makes an org "ownable", so the gate keeps the members-admin join purely to
-- preserve the "a membership-less fixture/seed org is NEVER gated" invariant;
-- only the unverified predicate moves from auth.users to organizations.
-- ---------------------------------------------------------------------------

alter table public.organizations
  add column if not exists spend_unlocked_at pg_catalog.timestamptz;

comment on column public.organizations.spend_unlocked_at is
  'When platform-credit SPENDING was unlocked for this org (NULL = spend gated). '
  'Set the moment the founding admin proves inbox ownership (clicks the emailed '
  'verification link / enters the code). Distinct from auth.users.email_confirmed_at, '
  'which only governs whether login is permitted. The P1025 spend gate in '
  'gateway_start_attempt keys on this column.';

-- Backfill: unlock every org that is NOT gated TODAY, so behavior is unchanged
-- for existing data. Today an org is gated ONLY when it has a PRESENT founding
-- admin whose email is unconfirmed; a memberless org (fixtures/seed) or an org
-- whose admin is confirmed is not gated. So unlock exactly the complement, and
-- leave spend_unlocked_at NULL only for orgs with an unverified founder (they
-- stay locked until they verify, as before). Guarded on auth.users existing: the
-- Docker migrate pass runs before GoTrue creates auth.users, and a fresh stack
-- has no organizations to backfill anyway (seed inserts them afterward, already
-- carrying the right spend_unlocked_at); hosted branches have auth.users and
-- real rows, so the backfill runs there.
do $$
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth.users does not exist yet; spend_unlocked_at backfill skipped (fresh stack has no orgs to backfill)';
    return;
  end if;
  update public.organizations orgs
     set spend_unlocked_at = pg_catalog.now()
   where orgs.spend_unlocked_at is null
     and not exists (
       select 1
         from public.organization_members members
         join auth.users users on users.id = members.user_id
        where members.org_id = orgs.id
          and members.role = 'admin'
          and users.email_confirmed_at is null
     );
end
$$;

-- ---------------------------------------------------------------------------
-- !!! SHARED FUNCTION BODY -- MERGE-TRAIN FLAG !!!
-- gateway_start_attempt is CREATE OR REPLACEd by several workstreams and the
-- LAST timestamp wins on a fresh migrate-all. This migration is the new LAST
-- redefinition and carries EVERY money guard. Anyone replacing this body later
-- must carry ALL of:
--   * spend gate (decoupled from login)      P1025 (host lane)
--   * RPM sliding window                      P1012 (host lane)
--   * TPM trailing settled-token window       P1022 (host lane)
--   * price-unknown fail-closed               P1013 (unconditional, host lane)
--   * per-key daily spend cap                 P1011
--   * balance + free-credit caps              P1010 / P1014 / P1015
--   * per-scope monthly budgets               P1016-P1019, P1023 key, P1024 model
-- pgTAP pins the COMPOSED function (budget enforcement, runtime, and the
-- spend-gate suite); explabs/gateway/e2e_test.py pins it end-to-end. Extend
-- those when touching this body.
--
-- Changes vs 20260822150000 (everything else is verbatim):
--   The P1025 spend gate no longer reads auth.users.email_confirmed_at; it reads
--   public.organizations.spend_unlocked_at. An org whose founding 'admin'
--   membership exists but whose spend_unlocked_at is null may not draw PLATFORM
--   credits. This decouples the gate from LOGIN: signup logs the user in
--   immediately (email_confirm:true), and the grant stays locked until the owner
--   proves inbox ownership by clicking the verification link, which sets
--   spend_unlocked_at. BYOK is unaffected: this block is host-lane only. The
--   members-admin join is KEPT so an org with no membership (fixtures, and every
--   existing host-lane pgTAP seed) is never gated. It still fires FIRST inside
--   the host block -- right after the org money lock, before the balance/cap/
--   budget checks -- and runs under the same organizations row lock as the caps.
-- ---------------------------------------------------------------------------

create or replace function public.gateway_start_attempt(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_attempt_ordinal pg_catalog.int4,
  p_route_depth pg_catalog.int4,
  p_deployment_id pg_catalog.text,
  p_provider pg_catalog.text,
  p_exact_model_id pg_catalog.text,
  p_pool_id pg_catalog.text,
  p_catalog_sha256 pg_catalog.text,
  p_billing_source pg_catalog.text,
  p_pricing_source pg_catalog.text,
  p_pricing_effective_at pg_catalog.timestamptz,
  p_input_rate_micro_usd pg_catalog.int8,
  p_cached_input_rate_micro_usd pg_catalog.int8,
  p_output_rate_micro_usd pg_catalog.int8,
  p_reasoning_rate_micro_usd pg_catalog.int8,
  p_maximum_cost_micro_usd pg_catalog.int8
)
returns table (attempt_id pg_catalog.text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.gateway_requests%rowtype;
  v_existing public.gateway_attempts%rowtype;
  v_attempt_id pg_catalog.text;
  v_period_start pg_catalog.timestamptz;
  v_limits public.gateway_key_limits%rowtype;
  v_rpm pg_catalog.int4;
  v_tpm pg_catalog.int4;
  v_cap pg_catalog.int8;
  v_recent pg_catalog.int8;
  v_recent_tokens pg_catalog.int8;
  v_spent_today pg_catalog.int8;
  v_policy record;
  -- gw-identity P-C additions: the request's budget-scope coordinates and the
  -- budget gate's verdict.
  v_identity_id pg_catalog.text;
  v_alias_id pg_catalog.text;
  v_budget_policy record;
begin
  perform public.gateway_require_service_role();
  if p_billing_source not in ('customer_managed', 'host_managed') then
    raise exception using errcode = '22023',
      message = 'invalid gateway attempt billing source';
  end if;
  select requests.* into v_request
    from public.gateway_requests requests
   where requests.request_id = p_request_id
   for update;
  if v_request.request_id is null then
    raise exception using errcode = 'P0002',
      message = 'gateway attempt request was not durably accepted';
  end if;
  if v_request.org_id <> p_org_id then
    raise exception using errcode = '23514',
      message = 'gateway attempt authority differs from the accepted request';
  end if;
  -- Replay receipt: a retried dispatch RPC (response lost after commit)
  -- returns the durable attempt id instead of a raw unique violation, and
  -- never re-reserves. Checked before the terminal/deadline gates so a late
  -- retry can still learn the id it needs to settle.
  select attempts.* into v_existing
    from public.gateway_attempts attempts
   where attempts.request_id = p_request_id
     and attempts.attempt_ordinal = p_attempt_ordinal;
  if v_existing.attempt_id is not null then
    if v_existing.org_id <> p_org_id
       or v_existing.deployment_id <> p_deployment_id
       or v_existing.billing_source <> p_billing_source then
      raise exception using errcode = '23505',
        message = 'gateway attempt ordinal is bound to a different dispatch';
    end if;
    return query select v_existing.attempt_id;
    return;
  end if;
  if v_request.terminal_state is not null then
    raise exception using errcode = '23514',
      message = 'gateway attempt request is already terminal';
  end if;
  if v_request.deadline_at <= pg_catalog.clock_timestamp() then
    -- Dispatching past the deadline would pay a provider for work the
    -- reconciler is already entitled to insure at zero.
    raise exception using errcode = '23514',
      message = 'gateway attempt request deadline has passed';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = v_request.api_key_id
      and keys.revoked_at is null
      and (keys.expires_at is null
        or keys.expires_at > pg_catalog.clock_timestamp())
  ) then
    -- Revocation bounds new provider streams: a key revoked between accept
    -- and dispatch must not keep spending on either lane.
    raise exception using errcode = '42501',
      message = 'gateway attempt api key is revoked or expired';
  end if;
  v_period_start := pg_catalog.date_trunc(
    'day', pg_catalog.clock_timestamp() at time zone 'UTC'
  ) at time zone 'UTC';

  if p_billing_source = 'host_managed' then
    -- Serialize all money decisions for the organization.
    perform 1 from public.organizations orgs
     where orgs.id = p_org_id
     for update;
    -- Spend gate, decoupled from login (money half of instant signup). An org
    -- whose founding admin exists but whose spend_unlocked_at is null cannot
    -- draw platform credits; everything else (login, BYOK, trace uploads,
    -- wiring the gateway, dashboard) is unaffected. Fires FIRST in the host
    -- block, before any spend computation, and only when a present admin
    -- membership exists -- so a membership-less fixture org is never gated.
    -- Opens the moment the founder proves inbox ownership (the verification
    -- click sets organizations.spend_unlocked_at). BYOK skips this whole block.
    if exists (
      select 1
        from public.organization_members members
        join public.organizations orgs on orgs.id = members.org_id
       where members.org_id = p_org_id
         and members.role = 'admin'
         and orgs.spend_unlocked_at is null
    ) then
      raise exception using errcode = 'P1025',
        message = 'org_owner_unverified: confirm your email to spend platform '
          || 'credits -- check your inbox for the verification link; everything '
          || 'else, including BYOK (your own provider keys) and trace uploads, '
          || 'works now';
    end if;
    select limits.* into v_limits
      from public.gateway_key_limits limits
     where limits.api_key_id = v_request.api_key_id;
    if v_limits.api_key_id is not null then
      v_rpm := v_limits.requests_per_minute;
      v_tpm := v_limits.tokens_per_minute;
      v_cap := v_limits.daily_spend_cap_micro_usd;
    else
      v_rpm := 60;
      v_tpm := null;
      v_cap := case
        when public.gateway_org_free_credit_funded(p_org_id) then 50000000
        else null
      end;
    end if;
    if v_rpm is not null then
      -- Count HOST-LANE dispatches only, so "BYOK traffic is never rate
      -- limited" holds in behavior: pass-through acceptance and dispatch
      -- never move this counter. Reads the attempt's own denormalized key so
      -- the scan is bounded by the 60s window (gateway_attempts_key_started_idx),
      -- not the key's lifetime request count.
      select pg_catalog.count(*) into v_recent
        from public.gateway_attempts attempts
       where attempts.api_key_id = v_request.api_key_id
         and attempts.billing_source = 'host_managed'
         and attempts.started_at
           >= pg_catalog.clock_timestamp() - pg_catalog.interval '60 seconds';
      if v_recent >= v_rpm then
        raise exception using errcode = 'P1012',
          message = pg_catalog.format(
            'key_rate_limit: this API key exceeded %s platform-funded '
            || 'dispatches per minute; slow down, or raise the key''s limit '
            || 'via the gateway key-limits API (BYOK dispatch is never '
            || 'counted or blocked)',
            v_rpm
          );
      end if;
    end if;
    if v_tpm is not null then
      -- TPM is trailing observation: token counts exist only after an attempt
      -- settles, so sum the settled tokens of attempts that went terminal in
      -- the last 60s and refuse the NEXT dispatch once the limit is met. A
      -- single large stream may overshoot; the key then waits out the window.
      -- Host lane only, like every money gate here.
      select coalesce(pg_catalog.sum(
          coalesce(attempts.input_tokens, 0)
          + coalesce(attempts.cached_input_tokens, 0)
          + coalesce(attempts.output_tokens, 0)
          + coalesce(attempts.reasoning_tokens, 0)), 0)
        into v_recent_tokens
        from public.gateway_attempts attempts
       where attempts.api_key_id = v_request.api_key_id
         and attempts.billing_source = 'host_managed'
         and attempts.terminal_at is not null
         and attempts.terminal_at
           >= pg_catalog.clock_timestamp() - pg_catalog.interval '60 seconds';
      if v_recent_tokens >= v_tpm then
        raise exception using errcode = 'P1022',
          message = pg_catalog.format(
            'key_token_rate_limit: this API key''s platform-funded traffic '
            || 'settled %s tokens in the last 60 seconds, at or past its %s '
            || 'tokens-per-minute limit; wait for the window to drain, or '
            || 'raise the key''s limit via the gateway key-limits API (BYOK '
            || 'dispatch is never counted or blocked)',
            v_recent_tokens, v_tpm
          );
      end if;
    end if;
    if p_maximum_cost_micro_usd is null then
      -- An unknown worst-case price cannot be bounded against a daily spend
      -- cap, the org credit balance, OR a per-scope budget: reserving it as $0
      -- (the historical coalesce below) slipped every one of those gates and
      -- let settlement drive the account negative. The ROUTE is ineligible
      -- (deployment scope; the waterfall advances to a known-price route, or
      -- the request fails if none is priced). Fires regardless of whether a
      -- daily cap applies, and BEFORE the balance/budget checks below, so no
      -- unknown price ever reaches them. BYOK is unaffected: host-lane only.
      raise exception using errcode = 'P1013',
        message = 'deployment_price_unknown: this route has no known price, so '
          || 'its spend cannot be bounded against the credit balance, a daily '
          || 'cap, or a scope budget; it is ineligible and another route may '
          || 'serve the request';
    end if;
    if v_cap is not null then
      select coalesce(pg_catalog.sum(
          case when attempts.state = 'dispatched'
            then attempts.budget_reserved_micro_usd
            else coalesce(attempts.budget_settled_micro_usd, 0)
          end), 0)
        into v_spent_today
        from public.gateway_attempts attempts
       where attempts.api_key_id = v_request.api_key_id
         and attempts.billing_source = 'host_managed'
         and attempts.budget_period_start = v_period_start;
      if v_spent_today + p_maximum_cost_micro_usd > v_cap then
        raise exception using errcode = 'P1011',
          message = pg_catalog.format(
            'key_daily_cap: this request''s worst case (%s micro-USD) would '
            || 'push the key past its %s micro-USD daily cap (%s already '
            || 'reserved or settled today, UTC); retry after 00:00 UTC or '
            || 'raise the cap via the gateway key-limits API',
            p_maximum_cost_micro_usd, v_cap, v_spent_today
          );
      end if;
    end if;
    select policy.allowed, policy.reason_code, policy.message into v_policy
      from public.gateway_spend_policy_check(
        p_org_id, p_exact_model_id, coalesce(p_maximum_cost_micro_usd, 0)
      ) policy;
    if not v_policy.allowed then
      raise exception using
        errcode = case v_policy.reason_code
          when 'insufficient_credits' then 'P1010'
          when 'org_daily_cap' then 'P1014'
          when 'model_daily_cap' then 'P1015'
          else 'P1010'
        end,
        message = coalesce(
          v_policy.message,
          'insufficient_credits: the organization''s credit balance is exhausted'
        );
    end if;

    -- gw-identity P-C: per-scope monthly budgets, composed ALONGSIDE billing's
    -- caps above -- both must pass. Resolve the request's budget-scope
    -- coordinates (identity from the key, alias from the frozen revision; both
    -- may be null for a hard-deleted key/unknown revision, which simply cannot
    -- match an identity/pool/deployment budget) and reject if any governing
    -- budget row would be exceeded. Still under the organizations row lock, so
    -- the check stays reservation-aware exactly like the caps.
    select keys.identity_id into v_identity_id
      from public.api_keys keys
     where keys.id = v_request.api_key_id;
    select revisions.alias_id into v_alias_id
      from public.gateway_alias_revisions revisions
     where revisions.revision_id = v_request.alias_revision_id;
    select budget.allowed, budget.reason_code, budget.message
      into v_budget_policy
      from public.gateway_budget_reservation_check(
        p_org_id, v_request.api_key_id, v_identity_id, v_alias_id, p_pool_id,
        p_deployment_id,
        -- Pass the real (nullable) worst-case cost, NOT coalesced to zero: an
        -- unknown price must fail closed against a finite budget rather than
        -- reserve nothing and overshoot on settlement.
        p_maximum_cost_micro_usd
      ) budget;
    if not v_budget_policy.allowed then
      raise exception using
        errcode = case v_budget_policy.reason_code
          when 'budget_team' then 'P1016'
          when 'budget_identity' then 'P1017'
          when 'budget_pool' then 'P1018'
          when 'budget_deployment' then 'P1019'
          when 'budget_key' then 'P1023'
          when 'budget_model' then 'P1024'
          else 'P1016'
        end,
        message = v_budget_policy.message;
    end if;
  end if;

  v_attempt_id := 'attempt-'
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', '');
  insert into public.gateway_attempts (
    attempt_id, request_id, org_id, api_key_id, attempt_ordinal, route_depth,
    deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
    billing_source, pricing_source, pricing_effective_at,
    input_rate_micro_usd, cached_input_rate_micro_usd,
    output_rate_micro_usd, reasoning_rate_micro_usd,
    state, started_at, budget_period_start, budget_reserved_micro_usd
  ) values (
    v_attempt_id, p_request_id, p_org_id, v_request.api_key_id,
    p_attempt_ordinal, p_route_depth,
    p_deployment_id, p_provider, p_exact_model_id, p_pool_id, p_catalog_sha256,
    p_billing_source, p_pricing_source, p_pricing_effective_at,
    p_input_rate_micro_usd, p_cached_input_rate_micro_usd,
    p_output_rate_micro_usd, p_reasoning_rate_micro_usd,
    'dispatched', pg_catalog.clock_timestamp(), v_period_start,
    coalesce(p_maximum_cost_micro_usd, 0)
  );
  return query select v_attempt_id;
end;
$$;

-- CREATE OR REPLACE preserves the runtime migration's grants on this signature
-- (revoked from public/anon/authenticated; executable by service_role).

-- ---------------------------------------------------------------------------
-- Re-key credential rotation from email verification to SPEND UNLOCK.
--
-- Rotation defense (originally migration 20260823010000) closed a credit-theft
-- chain: the public instant-signup / zero-click /signup create an account for
-- ANY typed email with no proof of inbox ownership, so an attacker could
-- instant-sign-up a victim's address, keep the returned key (or /signup
-- session), and drain the $20 the moment the real owner opened the gate. The
-- fix rotates every pre-unlock credential at the moment inbox ownership is
-- finally proven.
--
-- Under the decoupled model that moment is no longer "email_confirmed_at goes
-- non-null" (that now happens eagerly at signup so the user can log in); it is
-- "organizations.spend_unlocked_at goes non-null" (the verification click). So
-- the trigger moves off auth.users onto public.organizations and fires on the
-- first NULL->NOT NULL transition of spend_unlocked_at. Every membership present
-- at that instant was added while the org was locked (before inbox proof), so at
-- reclaim it trusts ONLY the founding admin and tears down the rest: (1) revokes
-- every api key of this org an admin minted while locked; (2) severs every member
-- session except the founder's NEWEST (the verifying one); and (3) EVICTS every
-- non-founder membership -- so a co-admin an attacker invited while holding the
-- pre-unlock founder session cannot survive to mint a fresh key (minting checks
-- live membership) and spend. The welcome grant is untouched.
-- ---------------------------------------------------------------------------

create function public.rotate_credentials_on_spend_unlock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The founding admin: the earliest-joined admin (what unlock_founder_spend
  -- keys on), tie-broken by user_id. The ONLY member trusted at reclaim.
  v_founder pg_catalog.uuid;
begin
  -- Only on the FIRST unlock: an INSERT already carrying spend_unlocked_at
  -- (seeded operator org; no pre-unlock credentials to rotate) or an UPDATE
  -- transitioning it from null (an instant-signup/zero-click org unlocking when
  -- the founder proves the inbox).
  if new.spend_unlocked_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.spend_unlocked_at is not null then
    return new;
  end if;
  -- Seeded/demo orgs manage their own keys; never rotate them. Skip when any
  -- founding admin of this org is a seed/demo account. (The demo seed repoints
  -- explabs.seed_admin_email at each demo email as it inserts it.)
  if exists (
    select 1
      from public.organization_members members
      join auth.users users on users.id = members.user_id
     where members.org_id = new.id
       and members.role = 'admin'
       and users.email in (
         nullif(pg_catalog.current_setting('explabs.seed_admin_email', true), ''),
         nullif(pg_catalog.current_setting('explabs.demo_seed_email', true), '')
       )
  ) then
    return new;
  end if;

  select founding.user_id into v_founder
    from public.organization_members founding
   where founding.org_id = new.id
     and founding.role = 'admin'
   order by founding.created_at asc, founding.user_id asc
   limit 1;

  -- The trigger fires AT the first unlock transition, so every membership that
  -- exists right now was added while the org was still locked -- i.e. before the
  -- founder proved the inbox. Only v_founder is trusted; every other member and
  -- their credentials are torn down (see the credit-theft chain in the header).

  -- 1. Revoke every key of THIS org an admin minted while locked (the founder's
  --    and any co-admin's). Scoped to keys.org_id = new.id so unlocking org A
  --    never revokes the founder's legitimate keys in another org B.
  update public.api_keys keys
     set revoked_at = pg_catalog.now()
    from public.organization_members members
   where members.org_id = new.id
     and members.role = 'admin'
     and keys.org_id = new.id
     and keys.created_by = members.user_id
     and keys.revoked_at is null;

  -- 2. Sever sessions of this org's members, keeping ONLY the founder's NEWEST
  --    (the verifying session that drove the unlock). This drops the attacker's
  --    retained founder session AND every co-admin's session, so no pre-reclaim
  --    session can act on the org. "Newest per founder" (not a time margin) keeps
  --    the verifying session even if the unlock lands seconds after it was minted.
  delete from auth.sessions sessions
   using public.organization_members members
   where members.org_id = new.id
     and sessions.user_id = members.user_id
     and not (
       members.user_id = v_founder
       and sessions.created_at = (
         select pg_catalog.max(newer.created_at)
           from auth.sessions newer
          where newer.user_id = v_founder
       )
     );

  -- 3. Evict every non-founder membership. An attacker holding the pre-unlock
  --    founder session could have invited a co-admin they control; without this
  --    they would remain an admin and mint a FRESH key to spend the unlocked
  --    credits (key minting checks LIVE membership, so removing it is what
  --    actually stops the re-mint). Anyone removed here re-joins after reclaim.
  delete from public.organization_members evicted
   where evicted.org_id = new.id
     and evicted.user_id <> v_founder;

  return new;
end;
$$;

revoke all on function public.rotate_credentials_on_spend_unlock()
  from public, anon, authenticated;

-- The trigger lives on public.organizations, which always exists at migration
-- time (unlike auth.users on the Docker stack), so it attaches here directly --
-- no seed-time deferral is needed.
drop trigger if exists rotate_credentials_on_spend_unlock on public.organizations;
create trigger rotate_credentials_on_spend_unlock
  after insert or update of spend_unlocked_at on public.organizations
  for each row execute function public.rotate_credentials_on_spend_unlock();

-- Retire the old email-verification-keyed rotation. The trigger sat on
-- auth.users (attached at migration time on hosted Supabase, at seed time on
-- Docker); drop it where auth.users exists, then drop both retired functions.
do $$
begin
  if to_regclass('auth.users') is not null then
    drop trigger if exists rotate_credentials_on_verify on auth.users;
  end if;
end
$$;

drop function if exists public.rotate_credentials_on_verify() cascade;
drop function if exists public.ensure_rotate_credentials_trigger();

-- ---------------------------------------------------------------------------
-- Unlock helper: set spend_unlocked_at for the org(s) a user FOUNDED.
--
-- Called by the web layer (lib/auth/spend-unlock.ts unlockSpendForUser) the
-- moment a user proves inbox ownership (verification magic link / emailed code /
-- OAuth). Scope is security-critical: it unlocks only orgs where the proving
-- user is the FOUNDING admin -- the EARLIEST-joined role='admin' membership --
-- which covers every founder path (self-serve signup and invite-to-found-a-new-
-- org) while EXCLUDING a later-invited admin. Unlocking on any admin membership
-- would let an attacker who instant-signed-up a victim's address invite a second
-- admin they control and unlock (and drain) the victim's founding org without
-- ever proving the victim's inbox. Only locked orgs are touched (idempotent),
-- and the write fires rotate_credentials_on_spend_unlock, evicting the
-- attacker's pre-unlock key/session.
-- ---------------------------------------------------------------------------
create or replace function public.unlock_founder_spend(p_user_id pg_catalog.uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.organizations orgs
     set spend_unlocked_at = pg_catalog.now()
   where orgs.spend_unlocked_at is null
     and exists (
       select 1
         from public.organization_members members
        where members.org_id = orgs.id
          and members.user_id = p_user_id
          and members.role = 'admin'
          -- The founding admin is the earliest-joined admin. A later-invited
          -- admin has a strictly greater created_at and so never matches.
          and members.created_at = (
            select pg_catalog.min(founding.created_at)
              from public.organization_members founding
             where founding.org_id = orgs.id
               and founding.role = 'admin'
          )
     );
end;
$$;

revoke all on function public.unlock_founder_spend(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.unlock_founder_spend(pg_catalog.uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Repoint the domain-join inbox-ownership gate off email_confirmed_at.
--
-- auth_user_verification (migration 20260822180000) fed the domain-based org-join
-- gate a boolean "is this email confirmed" read straight from
-- auth.users.email_confirmed_at. That was fine while email_confirmed_at meant
-- "proved inbox ownership", but this PR sets it EAGERLY at signup so the user can
-- log in -- so it no longer implies inbox proof, and an attacker who instant-
-- signs-up victim@corp.com could pass the join gate. Repoint the gate onto the
-- SAME inbox-proof signal the spend gate uses: the requester has proven their
-- inbox iff their FOUNDING org (earliest-joined admin membership, exactly what
-- unlock_founder_spend sets) has spend_unlocked_at set. email stays sourced from
-- auth.users for the domain match. The column is renamed email_confirmed_at ->
-- inbox_proven so no caller can mistake it for the raw login flag again.
-- ---------------------------------------------------------------------------
drop function if exists public.auth_user_verification(uuid);
create function public.auth_user_verification(target_user_id pg_catalog.uuid)
returns table (email pg_catalog.text, inbox_proven pg_catalog.bool)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not (
    public.is_platform_admin()
    or coalesce(
         nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
         nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb ->> 'role'
       ) = 'service_role'
    or target_user_id = public.authenticated_user_id()
  ) then
    raise exception 'not authorized to read verification state';
  end if;
  return query
    select
      users.email::pg_catalog.text,
      exists (
        select 1
          from public.organization_members members
          join public.organizations orgs on orgs.id = members.org_id
         where members.user_id = target_user_id
           and members.role = 'admin'
           and orgs.spend_unlocked_at is not null
           -- Only the FOUNDING admin (earliest membership) counts as inbox proof
           -- for this user, mirroring unlock_founder_spend's scope.
           and members.created_at = (
             select pg_catalog.min(founding.created_at)
               from public.organization_members founding
              where founding.org_id = orgs.id
                and founding.role = 'admin'
           )
      ) as inbox_proven
    from auth.users users
    where users.id = target_user_id;
end;
$$;

revoke all on function public.auth_user_verification(pg_catalog.uuid) from public, anon;
grant execute on function public.auth_user_verification(pg_catalog.uuid)
  to authenticated, service_role;
