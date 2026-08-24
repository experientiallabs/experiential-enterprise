-- Gateway runtime persistence: the WMO gateway's primary store in hosted mode.
--
-- In hosted mode the platform database IS the gateway's persistence, plugged
-- in through WMO's storage callback interfaces. There is no separate gateway
-- database and no sync step. Every entity below has exactly ONE sanctioned
-- write path — the security definer SQL function named for it — and nothing
-- else writes these tables (tables grant SELECT only; `gateway_key_limits`
-- is the one gateway-read-only table the control API writes directly).
--
--   gateway_requests, gateway_attempts       gateway_accept_request /
--                                            gateway_start_attempt /
--                                            gateway_settle_attempt /
--                                            gateway_finish_request /
--                                            gateway_reconcile_crashed
--   gateway_usage_events, gateway_usage_daily  emitted inside the same
--                                            settlement transaction (the
--                                            canonical usage store billing,
--                                            telemetry, and analytics read)
--   gateway_catalog_snapshots                gateway_register_catalog_snapshot
--   gateway_aliases, gateway_alias_revisions gateway_activate_alias_revision /
--                                            gateway_deactivate_alias
--   gateway_workers                          gateway_worker_heartbeat
--   gateway_key_limits                       control API (service role) direct
--
-- Money lanes: `customer_managed` (pass-through BYOK; attributed estimates,
-- never charged) and `host_managed` (platform-funded credits at provider
-- cost, zero markup, zero-completion insurance: a terminally failed or
-- zero-output-token attempt settles at 0 and releases its reservation).
--
-- Typed reservation errors (message always starts with the failing scope so
-- an agent can self-correct; the SQLSTATE lets the worker ledger map the
-- rejection scope for WMO's waterfall):
--   P1010 insufficient_credits        organization scope -> 429, stop routing
--   P1011 key_daily_cap               key scope          -> 429, stop routing
--   P1012 key_rate_limit              key scope          -> 429, stop routing
--   P1013 deployment_price_unknown    deployment scope   -> advance waterfall
--   P1014 org_daily_cap               organization scope (billing-owned)
--   P1015 model_daily_cap             model scope        (billing-owned)
--   P1020 idempotency_conflict        caller operation reused w/ new content
--   P1021 idempotency_replay_unavailable  matching keyed request exists

-- ---------------------------------------------------------------------------
-- 0. Service-role gate (defense in depth on top of execute grants; the
--    gateway worker's direct psycopg pool connects as postgres).

create function public.gateway_require_service_role()
returns pg_catalog.void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb ->> 'role',
    ''
  ) <> 'service_role'
  and session_user::pg_catalog.text not in ('postgres', 'supabase_admin') then
    raise exception using errcode = '42501', message = 'gateway RPC requires service role';
  end if;
end;
$$;

revoke all on function public.gateway_require_service_role()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Catalog snapshots: content-addressed catalog documents replacing WMO's
--    filesystem snapshots. Immutable.

create table public.gateway_catalog_snapshots (
  catalog_sha256 pg_catalog.text primary key
    check (catalog_sha256 ~ '^[0-9a-f]{64}$'),
  document pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(document) = 'object'
    and pg_catalog.octet_length(document::pg_catalog.text) <= 4194304
  ),
  models_document pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(models_document) = 'object'
    and pg_catalog.octet_length(models_document::pg_catalog.text) <= 4194304
  ),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

comment on table public.gateway_catalog_snapshots is
  'Content-addressed WMO catalog documents (immutable). Written only by gateway_register_catalog_snapshot.';

create function public.gateway_catalog_snapshots_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'gateway_catalog_snapshots is immutable; register a new content-addressed snapshot instead';
end;
$$;

revoke all on function public.gateway_catalog_snapshots_block_mutation()
  from public, anon, authenticated, service_role;

create trigger gateway_catalog_snapshots_append_only
before update or delete on public.gateway_catalog_snapshots
for each row execute function public.gateway_catalog_snapshots_block_mutation();

-- ---------------------------------------------------------------------------
-- 2. Aliases and their immutable revisions. An alias is the model slug a
--    customer puts in the `model` field; null org_id = public catalog entry.

create table public.gateway_aliases (
  alias_id pg_catalog.text primary key check (
    pg_catalog.char_length(alias_id) between 1 and 128
    and alias_id !~ '[[:cntrl:]]'
  ),
  alias_name pg_catalog.text not null check (
    pg_catalog.char_length(alias_name) between 1 and 128
    and alias_name !~ '[[:cntrl:]]'
  ),
  org_id pg_catalog.uuid references public.organizations(id) on delete cascade,
  active pg_catalog.bool not null default true,
  current_revision_id pg_catalog.text,
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  -- Names are unique per NAMESPACE, not globally: an org's custom model may
  -- deliberately reuse a public slug, and then SHADOWS the public alias for
  -- that org's keys. Resolution rule (implemented by the worker control
  -- store): look for the caller org's row first, fall back to the public
  -- (org_id null) row. NULLS NOT DISTINCT makes the public namespace behave
  -- like a real namespace instead of a null loophole.
  unique nulls not distinct (alias_name, org_id)
);

create table public.gateway_alias_revisions (
  revision_id pg_catalog.text primary key check (
    pg_catalog.char_length(revision_id) between 1 and 128
    and revision_id !~ '[[:cntrl:]]'
  ),
  alias_id pg_catalog.text not null
    references public.gateway_aliases(alias_id) on delete cascade,
  -- WMO DirectTarget: pool id plus ordered deployment ids.
  target pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(target) = 'object'
    and pg_catalog.octet_length(target::pg_catalog.text) <= 65536
  ),
  catalog_sha256 pg_catalog.text not null
    references public.gateway_catalog_snapshots(catalog_sha256),
  -- Map connection_id -> provider_connections.serving_revision frozen at
  -- activation, so a rotated BYOK credential is a visible revision change.
  provider_connection_revisions pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(provider_connection_revisions) = 'object'
    and pg_catalog.octet_length(provider_connection_revisions::pg_catalog.text) <= 65536
  ),
  -- For ordered pools: certification_id, provenance, evidence_sha256,
  -- certified_at, order. Null for single-deployment direct aliases.
  certification pg_catalog.jsonb check (
    certification is null
    or (
      pg_catalog.jsonb_typeof(certification) = 'object'
      and pg_catalog.octet_length(certification::pg_catalog.text) <= 16384
    )
  ),
  refusal_failover pg_catalog.bool not null default false,
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

alter table public.gateway_aliases
  add constraint gateway_aliases_current_revision_fkey
  foreign key (current_revision_id)
  references public.gateway_alias_revisions(revision_id);

create index gateway_alias_revisions_alias_idx
  on public.gateway_alias_revisions (alias_id, created_at desc);

comment on table public.gateway_aliases is
  'Model slugs customers place in the `model` field. org_id null = public catalog; set = that org''s custom model, which shadows a public alias of the same name for that org''s keys (lookup: org row wins, then public). Written only by gateway_activate_alias_revision / gateway_deactivate_alias.';
comment on table public.gateway_alias_revisions is
  'Immutable alias revisions binding a target, catalog snapshot, and frozen BYOK connection revisions. Written only by gateway_activate_alias_revision.';

-- Immutable rows; deletes only via the org-deletion cascade (the parent alias
-- row is already gone when the cascade reaches its revisions).
create function public.gateway_alias_revisions_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.gateway_aliases aliases
    where aliases.alias_id = old.alias_id
  ) then
    return old;
  end if;
  raise exception 'gateway_alias_revisions is append-only; activate a new revision instead';
end;
$$;

revoke all on function public.gateway_alias_revisions_block_mutation()
  from public, anon, authenticated, service_role;

create trigger gateway_alias_revisions_append_only
before update or delete on public.gateway_alias_revisions
for each row execute function public.gateway_alias_revisions_block_mutation();

-- ---------------------------------------------------------------------------
-- 3. Requests and attempts (content-free: bodies are never persisted, and
--    the content_retained = 0 checks keep that promise structural).

create table public.gateway_requests (
  request_id pg_catalog.text primary key check (
    pg_catalog.char_length(request_id) between 1 and 128
    and request_id !~ '[[:cntrl:]]'
  ),
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  -- Nulled if the key row is hard-deleted mid-flight: attribution here is a
  -- courtesy; the settled money record in gateway_usage_events keeps its
  -- own snapshot of the key id.
  api_key_id pg_catalog.uuid
    references public.api_keys(id) on delete set null,
  alias pg_catalog.text not null,
  alias_revision_id pg_catalog.text not null,
  api_surface pg_catalog.text not null check (
    api_surface in ('chat_completions', 'responses')
  ),
  canonical_request_sha256 pg_catalog.text not null
    check (canonical_request_sha256 ~ '^[0-9a-f]{64}$'),
  caller_operation_sha256 pg_catalog.text check (
    caller_operation_sha256 is null or caller_operation_sha256 ~ '^[0-9a-f]{64}$'
  ),
  accepted_at pg_catalog.timestamptz not null,
  deadline_at pg_catalog.timestamptz not null,
  terminal_state pg_catalog.text check (
    terminal_state is null or terminal_state in (
      'completed', 'failed', 'cancelled', 'incomplete',
      'expired_before_dispatch', 'unknown_after_crash'
    )
  ),
  terminal_at pg_catalog.timestamptz,
  content_retained pg_catalog.int4 not null default 0 check (content_retained = 0),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  check ((terminal_state is null) = (terminal_at is null))
);

create index gateway_requests_caller_operation_idx
  on public.gateway_requests (
    org_id, alias_revision_id, api_surface, caller_operation_sha256
  ) where caller_operation_sha256 is not null;
-- Key-scoped lookups: the rate guard joins the key's dispatches through
-- this, and per-key usage reads filter on it.
create index gateway_requests_key_accepted_idx
  on public.gateway_requests (api_key_id, accepted_at desc);
-- The crash reconciler scans open requests only.
create index gateway_requests_open_idx
  on public.gateway_requests (deadline_at)
  where terminal_state is null;

create table public.gateway_attempts (
  attempt_id pg_catalog.text primary key check (
    pg_catalog.char_length(attempt_id) between 1 and 128
    and attempt_id !~ '[[:cntrl:]]'
  ),
  request_id pg_catalog.text not null
    references public.gateway_requests(request_id) on delete cascade,
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  attempt_ordinal pg_catalog.int4 not null check (attempt_ordinal >= 0),
  route_depth pg_catalog.int4 not null check (route_depth >= 0),
  deployment_id pg_catalog.text not null,
  provider pg_catalog.text not null,
  exact_model_id pg_catalog.text not null,
  pool_id pg_catalog.text not null,
  catalog_sha256 pg_catalog.text not null check (catalog_sha256 ~ '^[0-9a-f]{64}$'),
  billing_source pg_catalog.text not null check (
    billing_source in ('customer_managed', 'host_managed')
  ),
  pricing_source pg_catalog.text,
  pricing_effective_at pg_catalog.timestamptz,
  route_reason pg_catalog.text,
  fallback_reason pg_catalog.text,
  -- Rates frozen at dispatch, micro-USD per million tokens. Null = unknown
  -- price (never coerced to zero; unknown-priced routes are ineligible when a
  -- hard cap applies and bill 0 on the platform-funded lane).
  input_rate_micro_usd pg_catalog.int8 check (
    input_rate_micro_usd is null or input_rate_micro_usd >= 0
  ),
  cached_input_rate_micro_usd pg_catalog.int8 check (
    cached_input_rate_micro_usd is null or cached_input_rate_micro_usd >= 0
  ),
  output_rate_micro_usd pg_catalog.int8 check (
    output_rate_micro_usd is null or output_rate_micro_usd >= 0
  ),
  reasoning_rate_micro_usd pg_catalog.int8 check (
    reasoning_rate_micro_usd is null or reasoning_rate_micro_usd >= 0
  ),
  state pg_catalog.text not null check (
    state in (
      'dispatched', 'completed', 'failed', 'cancelled',
      'incomplete', 'unknown_after_crash'
    )
  ),
  started_at pg_catalog.timestamptz not null,
  terminal_at pg_catalog.timestamptz,
  failure_class pg_catalog.text,
  input_tokens pg_catalog.int4 check (input_tokens is null or input_tokens >= 0),
  cached_input_tokens pg_catalog.int4 check (
    cached_input_tokens is null or cached_input_tokens >= 0
  ),
  output_tokens pg_catalog.int4 check (output_tokens is null or output_tokens >= 0),
  reasoning_tokens pg_catalog.int4 check (
    reasoning_tokens is null or reasoning_tokens >= 0
  ),
  usage_source pg_catalog.text check (
    usage_source is null or usage_source in ('observed', 'estimated', 'unknown')
  ),
  estimated_cost_micro_usd pg_catalog.int8 check (
    estimated_cost_micro_usd is null or estimated_cost_micro_usd >= 0
  ),
  budget_period_start pg_catalog.timestamptz not null,
  budget_reserved_micro_usd pg_catalog.int8 not null default 0
    check (budget_reserved_micro_usd >= 0),
  budget_settled_micro_usd pg_catalog.int8 check (
    budget_settled_micro_usd is null or budget_settled_micro_usd >= 0
  ),
  content_retained pg_catalog.int4 not null default 0 check (content_retained = 0),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  unique (request_id, attempt_ordinal),
  check ((state = 'dispatched') = (terminal_at is null))
);

create index gateway_attempts_usage_idx
  on public.gateway_attempts (org_id, terminal_at, state);
-- Outstanding-reservation reads (the balance gate) and the crash reconciler
-- touch only in-flight attempts.
create index gateway_attempts_dispatched_idx
  on public.gateway_attempts (org_id, budget_reserved_micro_usd)
  where state = 'dispatched';

comment on table public.gateway_requests is
  'One row per accepted /v1 request, content-free. Written only by the gateway_* SQL functions.';
comment on table public.gateway_attempts is
  'One row per physical provider dispatch, inserted before network work. budget_settled_micro_usd: amount actually charged to platform credits for host_managed; attributed never-charged estimate for customer_managed.';

-- ---------------------------------------------------------------------------
-- 4. Per-key guardrails (host_managed lane only). The one gateway table the
--    control API (P5) writes directly: no gateway invariant lives behind it.

create table public.gateway_key_limits (
  api_key_id pg_catalog.uuid primary key
    references public.api_keys(id) on delete cascade,
  daily_spend_cap_micro_usd pg_catalog.int8 check (
    daily_spend_cap_micro_usd is null or daily_spend_cap_micro_usd >= 0
  ),
  requests_per_minute pg_catalog.int4 check (
    requests_per_minute is null or requests_per_minute > 0
  ),
  updated_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

comment on table public.gateway_key_limits is
  'Per-key guardrails on the platform-funded lane only (BYOK traffic is never rate limited). Explicit null cap/rpm = uncapped. No row = rpm 60, and a $50/day cap only while the org is free-credit funded.';

-- ---------------------------------------------------------------------------
-- 5. Worker registry.

create table public.gateway_workers (
  worker_id pg_catalog.text primary key check (
    pg_catalog.char_length(worker_id) between 1 and 128
    and worker_id !~ '[[:cntrl:]]'
  ),
  state pg_catalog.text not null check (
    state in ('starting', 'ready', 'draining', 'dead')
  ),
  started_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  heartbeat_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  catalog_sha256 pg_catalog.text check (
    catalog_sha256 is null or catalog_sha256 ~ '^[0-9a-f]{64}$'
  ),
  app_version pg_catalog.text,
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

comment on table public.gateway_workers is
  'Gateway worker registration and heartbeats. Written only by gateway_worker_heartbeat; staleness (heartbeat older than 60s) is derived at read time.';

-- ---------------------------------------------------------------------------
-- 6. CANONICAL USAGE STORE (cross-team contract). One gateway_usage_events
--    row per finished request and a per-user daily rollup, both written in
--    the settlement transaction. Billing, telemetry, and analytics read
--    these two tables and nothing else of the gateway's. Column semantics
--    are the contract; do not change them without circulating.

create table public.gateway_usage_events (
  -- The finished request's id; exactly one event per finished request.
  request_id pg_catalog.text primary key
    references public.gateway_requests(request_id) on delete cascade,
  -- Owning organization.
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  -- The platform API key that made the request (attribution snapshot; the
  -- id outlives the key row). Null only when the key was hard-deleted
  -- before the request settled.
  api_key_id pg_catalog.uuid,
  -- The key's creating user at settlement time; null when the key has no
  -- creator recorded. A user's numbers sum across all of their keys.
  user_id pg_catalog.uuid,
  -- Model slug the customer requested (the `model` field).
  alias pg_catalog.text not null,
  -- Winning (final) attempt's provider; null if nothing was dispatched.
  provider pg_catalog.text,
  -- pass_through = customer's own provider key (never charged by us);
  -- platform_funded = platform credits at provider cost. Null if nothing
  -- was dispatched (no lane was exercised).
  lane pg_catalog.text check (lane in ('pass_through', 'platform_funded')),
  -- Winning attempt's observed usage; 0 when unknown or nothing dispatched.
  input_tokens pg_catalog.int8 not null default 0 check (input_tokens >= 0),
  output_tokens pg_catalog.int8 not null default 0 check (output_tokens >= 0),
  -- Charged money ONLY, integer micro-USD: the sum of host_managed
  -- settlements across ALL of the request's attempts, zero-completion
  -- insurance already applied. Zero for pure pass-through requests.
  cost_micro_usd pg_catalog.int8 not null default 0 check (cost_micro_usd >= 0),
  -- Attributed NEVER-CHARGED money, integer micro-USD: list-price estimates
  -- for the request's customer_managed (pass-through) attempts, including
  -- the reconciler's reserved-amount estimate for crashed BYOK work. Split
  -- from cost_micro_usd so charged and estimated money never mix in one
  -- number.
  estimated_cost_micro_usd pg_catalog.int8 not null default 0
    check (estimated_cost_micro_usd >= 0),
  -- Wall-clock milliseconds from acceptance to terminal state.
  latency_ms pg_catalog.int4 check (latency_ms is null or latency_ms >= 0),
  -- The request's terminal state: completed | failed | cancelled |
  -- incomplete | expired_before_dispatch | unknown_after_crash.
  status pg_catalog.text not null check (
    status in (
      'completed', 'failed', 'cancelled', 'incomplete',
      'expired_before_dispatch', 'unknown_after_crash'
    )
  ),
  -- Number of physical provider dispatches (0 = failed before dispatch).
  attempt_count pg_catalog.int4 not null check (attempt_count >= 0),
  -- UTC date of the terminal timestamp; the rollup bucket key.
  day pg_catalog.date not null,
  -- SETTLEMENT wall clock (clock_timestamp() when the settlement transaction
  -- finalized the request). day and latency_ms derive from the REQUEST's own
  -- clock (terminal_at / accepted_at), so created_at can disagree with day
  -- near the UTC midnight boundary and after crash reconciliation.
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

create index gateway_usage_events_org_day_idx
  on public.gateway_usage_events (org_id, day desc, created_at desc);
create index gateway_usage_events_key_idx
  on public.gateway_usage_events (api_key_id, created_at desc);
-- Cross-org trailing-window reads (analytics digest, admin views) filter on
-- created_at alone. A bare (created_at) index serves them and, as a single
-- mostly-monotonic timestamptz, appends to the rightmost leaf — the least
-- write amplification the settle path can pay. (day, created_at) was
-- rejected: day is the request-clock UTC date and can disagree with
-- settlement time (see the created_at column note), so leading with it
-- would invite window queries that silently miss boundary rows.
create index gateway_usage_events_created_idx
  on public.gateway_usage_events (created_at);

comment on table public.gateway_usage_events is
  'CANONICAL per-request usage stream for the gateway launch. One row per finished request, written in the settlement transaction. Billing, telemetry, and analytics read this; nothing besides the gateway settlement functions writes it.';

create table public.gateway_usage_daily (
  -- Owning organization.
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  -- The event's user_id with null bucketed as the zero uuid, so the primary
  -- key stays total. Filter it out for per-user views; include it for org
  -- totals.
  user_id pg_catalog.uuid not null default '00000000-0000-0000-0000-000000000000',
  -- UTC day (gateway_usage_events.day).
  day pg_catalog.date not null,
  -- Model slug (gateway_usage_events.alias).
  alias pg_catalog.text not null,
  -- Finished requests in the bucket.
  requests pg_catalog.int8 not null default 0 check (requests >= 0),
  -- Token sums over the bucket's events.
  input_tokens pg_catalog.int8 not null default 0 check (input_tokens >= 0),
  output_tokens pg_catalog.int8 not null default 0 check (output_tokens >= 0),
  -- One user-facing spend meter: the sum of the bucket's events'
  -- cost_micro_usd + estimated_cost_micro_usd. The charged/estimated split
  -- lives in gateway_usage_events.
  spend_micro_usd pg_catalog.int8 not null default 0 check (spend_micro_usd >= 0),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (org_id, user_id, day, alias)
);

-- The account Overview page reads per-user ranges up to all-time.
create index gateway_usage_daily_user_day_idx
  on public.gateway_usage_daily (user_id, day desc);

comment on table public.gateway_usage_daily is
  'CANONICAL per-user/day/model rollup of gateway_usage_events, incremented in the same settlement transaction (never lags, never double-counts). Answers per-user daily spend/tokens/requests and top-models cheaply.';

-- Events are settled money history: append-only for everyone, no
-- exceptions. Deliberate consequence: an organization with settled gateway
-- history cannot be hard-deleted — the org-deletion cascade reaches these
-- rows and aborts on this trigger. Fail-loudly by design: erasing an org
-- must first deal with its money history explicitly.
create function public.gateway_usage_events_block_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'gateway_usage_events is append-only settled money history';
end;
$$;

revoke all on function public.gateway_usage_events_block_mutation()
  from public, anon, authenticated, service_role;

create trigger gateway_usage_events_append_only
before update or delete on public.gateway_usage_events
for each row execute function public.gateway_usage_events_block_mutation();

-- ---------------------------------------------------------------------------
-- 7. Row security and grants. All tables are service-role read; every write
--    goes through the definer functions below, except gateway_key_limits
--    (control-API-owned settings, no gateway invariant behind them).

alter table public.gateway_catalog_snapshots enable row level security;
alter table public.gateway_aliases enable row level security;
alter table public.gateway_alias_revisions enable row level security;
alter table public.gateway_requests enable row level security;
alter table public.gateway_attempts enable row level security;
alter table public.gateway_key_limits enable row level security;
alter table public.gateway_workers enable row level security;
alter table public.gateway_usage_events enable row level security;
alter table public.gateway_usage_daily enable row level security;

revoke all on table public.gateway_catalog_snapshots
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_aliases
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_alias_revisions
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_requests
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_attempts
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_key_limits
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_workers
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_usage_events
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_usage_daily
  from public, anon, authenticated, service_role;

grant select on table public.gateway_catalog_snapshots to service_role;
grant select on table public.gateway_aliases to service_role;
grant select on table public.gateway_alias_revisions to service_role;
grant select on table public.gateway_requests to service_role;
grant select on table public.gateway_attempts to service_role;
grant select, insert, update, delete on table public.gateway_key_limits to service_role;
grant select on table public.gateway_workers to service_role;
grant select on table public.gateway_usage_events to service_role;
grant select on table public.gateway_usage_daily to service_role;

-- ---------------------------------------------------------------------------
-- 8. BILLING-OWNED POLICY SEAM. The three functions below are the org-level
--    money policy hooks. This migration ships STUB bodies (balance gate
--    only, permissive caps, generic copy); the billing workstream replaces
--    the bodies WITHOUT changing the signatures. Two parts of the stubs are
--    load-bearing contracts that must survive the rewrite:
--      * gateway_spend_policy_check's balance term must keep subtracting
--        outstanding gateway reservations (dispatched host_managed
--        attempts) — the concurrent-reservation pgTAP test pins this; and
--      * callers hold the organizations row lock before invoking it, so the
--        check-then-reserve sequence serializes.
--    Balance semantics: a balance strictly greater than zero admits the
--    request even when its worst case takes the balance negative (one honest
--    overdraft); a balance at or below zero blocks.

create function public.gateway_org_free_credit_funded(p_org_id pg_catalog.uuid)
returns pg_catalog.bool
language sql
stable
security definer
set search_path = ''
as $$
  -- STUB (billing-owned): free-credit funded = no paid Stripe top-up ever.
  -- Billing replaces this with its real funding-source predicate.
  select not exists (
    select 1 from public.credit_ledger ledger
    where ledger.org_id = p_org_id and ledger.source = 'stripe'
  );
$$;

revoke all on function public.gateway_org_free_credit_funded(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.gateway_org_free_credit_funded(pg_catalog.uuid)
  to service_role;

create function public.gateway_spend_policy_check(
  p_org_id pg_catalog.uuid,
  p_model pg_catalog.text,
  p_proposed_micro_usd pg_catalog.int8
)
returns table (
  allowed pg_catalog.bool,
  reason_code pg_catalog.text,
  message pg_catalog.text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance pg_catalog.numeric;
  v_outstanding pg_catalog.int8;
begin
  -- STUB (billing-owned): balance>0 gate only. Billing adds the $50/day
  -- per-org cap, the $25/day per-model cap (p_model / p_proposed_micro_usd
  -- exist for those), and YC-aware error copy, keeping the reservation-aware
  -- balance term and this signature intact.
  select orgs.credit_granted_usd - orgs.billable_spend_usd
    into v_balance
    from public.organizations orgs
   where orgs.id = p_org_id;
  if v_balance is null then
    return query select false, 'insufficient_credits'::pg_catalog.text,
      'insufficient_credits: the organization does not exist'::pg_catalog.text;
    return;
  end if;
  select coalesce(pg_catalog.sum(attempts.budget_reserved_micro_usd), 0)
    into v_outstanding
    from public.gateway_attempts attempts
   where attempts.org_id = p_org_id
     and attempts.state = 'dispatched'
     and attempts.billing_source = 'host_managed';
  if v_balance - (v_outstanding::pg_catalog.numeric / 1000000) <= 0 then
    return query select false, 'insufficient_credits'::pg_catalog.text,
      ('insufficient_credits: the organization''s credit balance is exhausted; '
       || 'add credits or route this request through your own provider key '
       || '(BYOK traffic is never blocked)')::pg_catalog.text;
    return;
  end if;
  return query select true, null::pg_catalog.text, null::pg_catalog.text;
end;
$$;

revoke all on function public.gateway_spend_policy_check(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.gateway_spend_policy_check(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8
) to service_role;

create function public.gateway_settle_billing(
  p_org_id pg_catalog.uuid,
  p_request_id pg_catalog.text,
  p_attempt_id pg_catalog.text,
  p_settled_micro_usd pg_catalog.int8
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- BILLING-OWNED BODY. Working launch behavior: draw the settled amount
  -- down from platform credits by bumping billable_spend_usd (the balance
  -- gate reads granted - billable). Deliberately NOT bumping the spend_usd
  -- display meter: recompute_org_spend cannot see gateway rows, and the
  -- Overview reads gateway_usage_daily instead. Billing owns this body and
  -- adds its credit-ledger projection (entry shape theirs) here; callers
  -- invoke it for every host_managed settlement, including zero-amount
  -- insurance releases, so the seam observes every outcome.
  if p_settled_micro_usd is null or p_settled_micro_usd < 0 then
    raise exception using errcode = '22023',
      message = 'gateway settlement amount must be a nonnegative micro-USD integer';
  end if;
  if p_settled_micro_usd = 0 then
    return;
  end if;
  update public.organizations
     set billable_spend_usd =
       billable_spend_usd + (p_settled_micro_usd::pg_catalog.numeric / 1000000)
   where id = p_org_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'gateway settlement organization does not exist';
  end if;
end;
$$;

revoke all on function public.gateway_settle_billing(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.gateway_settle_billing(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int8
) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Catalog and alias write paths.

create function public.gateway_register_catalog_snapshot(
  p_catalog_sha256 pg_catalog.text,
  p_document pg_catalog.jsonb,
  p_models_document pg_catalog.jsonb
)
returns table (changed pg_catalog.bool)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.gateway_catalog_snapshots%rowtype;
  v_inserted pg_catalog.bool;
begin
  perform public.gateway_require_service_role();
  -- Insert-first: the hosting platform cold-boots both workers at once, so two of them
  -- can race to register the same NEW digest. The loser's insert waits out
  -- the winner's transaction, lands on the conflict, and takes the receipt
  -- path below — content-addressed, so a same-digest collision is
  -- definitionally identical content and both boots succeed.
  insert into public.gateway_catalog_snapshots (
    catalog_sha256, document, models_document
  ) values (p_catalog_sha256, p_document, p_models_document)
  on conflict (catalog_sha256) do nothing
  returning true into v_inserted;
  if v_inserted then
    return query select true;
    return;
  end if;
  select snapshots.* into v_existing
    from public.gateway_catalog_snapshots snapshots
   where snapshots.catalog_sha256 = p_catalog_sha256;
  if v_existing.document <> p_document
     or v_existing.models_document <> p_models_document then
    raise exception using errcode = '23505',
      message = 'catalog snapshot content drifted for an existing digest';
  end if;
  return query select false;
end;
$$;

revoke all on function public.gateway_register_catalog_snapshot(
  pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.gateway_register_catalog_snapshot(
  pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb
) to service_role;

create function public.gateway_activate_alias_revision(
  p_alias_id pg_catalog.text,
  p_alias_name pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_revision_id pg_catalog.text,
  p_target pg_catalog.jsonb,
  p_catalog_sha256 pg_catalog.text,
  p_provider_connection_revisions pg_catalog.jsonb,
  p_certification pg_catalog.jsonb,
  p_refusal_failover pg_catalog.bool default false
)
returns table (changed pg_catalog.bool)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alias public.gateway_aliases%rowtype;
  v_revision public.gateway_alias_revisions%rowtype;
begin
  perform public.gateway_require_service_role();
  -- Typed collision so the catalog builder gets a self-explanatory error
  -- instead of a bare unique violation. Namespace-aware: the same name in
  -- another org's namespace (or the public one) is legal shadowing.
  if exists (
    select 1 from public.gateway_aliases aliases
    where aliases.alias_name = p_alias_name
      and aliases.org_id is not distinct from p_org_id
      and aliases.alias_id <> p_alias_id
  ) then
    raise exception using errcode = '23505',
      message = 'alias name is already bound to a different alias id in this namespace';
  end if;
  insert into public.gateway_aliases (alias_id, alias_name, org_id)
  values (p_alias_id, p_alias_name, p_org_id)
  on conflict on constraint gateway_aliases_pkey do nothing;
  -- Concurrent cold-boot safety: everything past this lock is serialized
  -- per alias, so the revision existence check below cannot race a sibling
  -- worker's insert of the same revision (the loser re-reads under a fresh
  -- snapshot and takes the verify path). The bare revision insert stays
  -- bare on purpose: a cross-alias revision-id collision must fail loudly,
  -- not be absorbed by an ON CONFLICT.
  select aliases.* into v_alias
    from public.gateway_aliases aliases
   where aliases.alias_id = p_alias_id
   for update;
  if v_alias.alias_name <> p_alias_name
     or v_alias.org_id is distinct from p_org_id then
    raise exception using errcode = '23505',
      message = 'alias identity drifted: alias_id is bound to another name or organization';
  end if;
  select revisions.* into v_revision
    from public.gateway_alias_revisions revisions
   where revisions.revision_id = p_revision_id;
  if v_revision.revision_id is not null then
    if v_revision.alias_id <> p_alias_id
       or v_revision.target <> p_target
       or v_revision.catalog_sha256 <> p_catalog_sha256
       or v_revision.provider_connection_revisions
         <> p_provider_connection_revisions
       or v_revision.certification is distinct from p_certification
       or v_revision.refusal_failover <> p_refusal_failover then
      raise exception using errcode = '23505',
        message = 'alias revision content drifted for an existing revision id';
    end if;
    -- Operation-receipt spirit: re-activating the active revision is a no-op.
    if v_alias.current_revision_id = p_revision_id and v_alias.active then
      return query select false;
      return;
    end if;
  else
    insert into public.gateway_alias_revisions (
      revision_id, alias_id, target, catalog_sha256,
      provider_connection_revisions, certification, refusal_failover
    ) values (
      p_revision_id, p_alias_id, p_target, p_catalog_sha256,
      p_provider_connection_revisions, p_certification, p_refusal_failover
    );
  end if;
  update public.gateway_aliases
     set current_revision_id = p_revision_id,
         active = true
   where alias_id = p_alias_id;
  return query select true;
end;
$$;

revoke all on function public.gateway_activate_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool
) from public, anon, authenticated;
grant execute on function public.gateway_activate_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool
) to service_role;

-- Retire a model slug from routing. The revision history and the
-- current-revision pointer stay intact, so re-activating the same revision
-- through gateway_activate_alias_revision brings the alias back.
create function public.gateway_deactivate_alias(p_alias_id pg_catalog.text)
returns table (changed pg_catalog.bool)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alias public.gateway_aliases%rowtype;
begin
  perform public.gateway_require_service_role();
  select aliases.* into v_alias
    from public.gateway_aliases aliases
   where aliases.alias_id = p_alias_id
   for update;
  if v_alias.alias_id is null then
    raise exception using errcode = 'P0002',
      message = 'alias does not exist';
  end if;
  if not v_alias.active then
    return query select false;
    return;
  end if;
  update public.gateway_aliases
     set active = false
   where alias_id = p_alias_id;
  return query select true;
end;
$$;

revoke all on function public.gateway_deactivate_alias(pg_catalog.text)
  from public, anon, authenticated;
grant execute on function public.gateway_deactivate_alias(pg_catalog.text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 10. Request/attempt write paths.

create function public.gateway_accept_request(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_api_key_id pg_catalog.uuid,
  p_alias pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_api_surface pg_catalog.text,
  p_canonical_request_sha256 pg_catalog.text,
  p_caller_operation_sha256 pg_catalog.text,
  p_deadline_at pg_catalog.timestamptz
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prior record;
  v_existing public.gateway_requests%rowtype;
begin
  perform public.gateway_require_service_role();
  if p_deadline_at is null then
    raise exception using errcode = '22023',
      message = 'accepted gateway request requires a deadline';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = p_api_key_id and keys.org_id = p_org_id
  ) then
    raise exception using errcode = '42501',
      message = 'gateway request key attribution is invalid';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = p_api_key_id
      and keys.revoked_at is null
      and (keys.expires_at is null
        or keys.expires_at > pg_catalog.clock_timestamp())
  ) then
    raise exception using errcode = '42501',
      message = 'gateway request api key is revoked or expired';
  end if;
  -- Replay receipt: a retried accept RPC (worker retried after a lost
  -- response) is a no-op when the durable row matches; drifted content under
  -- the same request id is refused with a typed conflict, never a raw
  -- constraint error.
  select requests.* into v_existing
    from public.gateway_requests requests
   where requests.request_id = p_request_id;
  if v_existing.request_id is not null then
    if v_existing.org_id <> p_org_id
       or v_existing.api_key_id is distinct from p_api_key_id
       or v_existing.alias_revision_id <> p_alias_revision_id
       or v_existing.api_surface <> p_api_surface
       or v_existing.canonical_request_sha256 <> p_canonical_request_sha256
       or v_existing.caller_operation_sha256
         is distinct from p_caller_operation_sha256 then
      raise exception using errcode = '23505',
        message = 'gateway request id is bound to different accepted content';
    end if;
    return;
  end if;
  if p_caller_operation_sha256 is not null then
    -- Serialize concurrent accepts of the same caller operation: without
    -- this, two simultaneous submissions with one Idempotency-Key both pass
    -- the probe below (neither sees the other's uncommitted insert) and the
    -- operation dispatches — and charges — twice.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'gateway_accept_request:' || p_org_id::pg_catalog.text || ':'
        || p_alias_revision_id || ':' || p_api_surface || ':'
        || p_caller_operation_sha256,
        0
      )
    );
    select requests.canonical_request_sha256, requests.terminal_state
      into v_prior
      from public.gateway_requests requests
     where requests.org_id = p_org_id
       and requests.alias_revision_id = p_alias_revision_id
       and requests.api_surface = p_api_surface
       and requests.caller_operation_sha256 = p_caller_operation_sha256
     order by requests.accepted_at desc
     limit 1;
    if v_prior.canonical_request_sha256 is not null then
      if v_prior.canonical_request_sha256 <> p_canonical_request_sha256 then
        raise exception using errcode = 'P1020',
          message = 'idempotency_conflict: the caller operation key was reused '
            || 'with different request content; mint a new Idempotency-Key';
      end if;
      if v_prior.terminal_state is null or v_prior.terminal_state not in (
        'expired_before_dispatch', 'unknown_after_crash'
      ) then
        raise exception using errcode = 'P1021',
          message = 'idempotency_replay_unavailable: a matching keyed request '
            || 'exists but durable content replay is unavailable; resend the '
            || 'full request with a new Idempotency-Key';
      end if;
    end if;
  end if;
  insert into public.gateway_requests (
    request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
    canonical_request_sha256, caller_operation_sha256, accepted_at, deadline_at
  ) values (
    p_request_id, p_org_id, p_api_key_id, p_alias, p_alias_revision_id,
    p_api_surface, p_canonical_request_sha256, p_caller_operation_sha256,
    pg_catalog.clock_timestamp(), p_deadline_at
  );
end;
$$;

revoke all on function public.gateway_accept_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz
) from public, anon, authenticated;
grant execute on function public.gateway_accept_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz
) to service_role;

-- Reserve-then-dispatch. Money is enforced BEFORE the attempt row exists:
-- the organizations row lock serializes concurrent reservations, so the
-- balance and cap sums always see every prior committed reservation.
create function public.gateway_start_attempt(
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
  v_cap pg_catalog.int8;
  v_recent pg_catalog.int8;
  v_spent_today pg_catalog.int8;
  v_policy record;
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
    select limits.* into v_limits
      from public.gateway_key_limits limits
     where limits.api_key_id = v_request.api_key_id;
    if v_limits.api_key_id is not null then
      v_rpm := v_limits.requests_per_minute;
      v_cap := v_limits.daily_spend_cap_micro_usd;
    else
      v_rpm := 60;
      v_cap := case
        when public.gateway_org_free_credit_funded(p_org_id) then 50000000
        else null
      end;
    end if;
    if v_rpm is not null then
      -- Count HOST-LANE dispatches only, so "BYOK traffic is never rate
      -- limited" holds in behavior: pass-through acceptance and dispatch
      -- never move this counter.
      select pg_catalog.count(*) into v_recent
        from public.gateway_attempts attempts
        join public.gateway_requests requests
          on requests.request_id = attempts.request_id
       where requests.api_key_id = v_request.api_key_id
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
    if v_cap is not null and p_maximum_cost_micro_usd is null then
      -- Unknown worst-case price cannot be bounded under a hard cap: the
      -- ROUTE is ineligible (deployment scope; the waterfall advances).
      raise exception using errcode = 'P1013',
        message = 'deployment_price_unknown: this route has no known price and '
          || 'a daily spend cap applies, so it is ineligible; another route '
          || 'may serve the request';
    end if;
    if v_cap is not null then
      select coalesce(pg_catalog.sum(
          case when attempts.state = 'dispatched'
            then attempts.budget_reserved_micro_usd
            else coalesce(attempts.budget_settled_micro_usd, 0)
          end), 0)
        into v_spent_today
        from public.gateway_attempts attempts
        join public.gateway_requests requests
          on requests.request_id = attempts.request_id
       where requests.api_key_id = v_request.api_key_id
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
  end if;

  v_attempt_id := 'attempt-'
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', '');
  insert into public.gateway_attempts (
    attempt_id, request_id, org_id, attempt_ordinal, route_depth,
    deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
    billing_source, pricing_source, pricing_effective_at,
    input_rate_micro_usd, cached_input_rate_micro_usd,
    output_rate_micro_usd, reasoning_rate_micro_usd,
    state, started_at, budget_period_start, budget_reserved_micro_usd
  ) values (
    v_attempt_id, p_request_id, p_org_id, p_attempt_ordinal, p_route_depth,
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

revoke all on function public.gateway_start_attempt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.int4, pg_catalog.int4,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8, pg_catalog.int8,
  pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.gateway_start_attempt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.int4, pg_catalog.int4,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8, pg_catalog.int8,
  pg_catalog.int8
) to service_role;

-- Attributed cost from frozen rates, mirroring WMO's ledger: unknown when
-- usage is absent or any consumed dimension has no rate; otherwise integer
-- micro-USD rounded half up. Internal helper, no direct grants.
create function public.gateway_attempt_cost_micro_usd(
  p_input_tokens pg_catalog.int4,
  p_cached_input_tokens pg_catalog.int4,
  p_output_tokens pg_catalog.int4,
  p_reasoning_tokens pg_catalog.int4,
  p_input_rate pg_catalog.int8,
  p_cached_input_rate pg_catalog.int8,
  p_output_rate pg_catalog.int8,
  p_reasoning_rate pg_catalog.int8
)
returns pg_catalog.int8
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when p_input_tokens is null and p_output_tokens is null then null
    when (coalesce(p_input_tokens, 0) > 0 and p_input_rate is null)
      or (coalesce(p_cached_input_tokens, 0) > 0 and p_cached_input_rate is null)
      or (coalesce(p_output_tokens, 0) > 0 and p_output_rate is null)
      or (coalesce(p_reasoning_tokens, 0) > 0 and p_reasoning_rate is null)
      then null
    else (
      coalesce(p_input_tokens, 0)::pg_catalog.int8 * coalesce(p_input_rate, 0)
      + coalesce(p_cached_input_tokens, 0)::pg_catalog.int8
        * coalesce(p_cached_input_rate, 0)
      + coalesce(p_output_tokens, 0)::pg_catalog.int8 * coalesce(p_output_rate, 0)
      + coalesce(p_reasoning_tokens, 0)::pg_catalog.int8
        * coalesce(p_reasoning_rate, 0)
      + 500000
    ) / 1000000
  end;
$$;

revoke all on function public.gateway_attempt_cost_micro_usd(
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.int4,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8, pg_catalog.int8
) from public, anon, authenticated, service_role;

-- Emit the canonical usage event and bump the daily rollup for one terminal
-- request. Idempotent: the event insert is keyed on request_id and the
-- rollup increments only when the event row is new, so a replayed finalize
-- can never double-count. Internal helper, no direct grants.
create function public.gateway_finalize_usage(p_request_id pg_catalog.text)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.gateway_requests%rowtype;
  v_winning record;
  v_attempt_count pg_catalog.int4;
  v_cost pg_catalog.int8;
  v_estimated pg_catalog.int8;
  v_user pg_catalog.uuid;
  v_inserted pg_catalog.bool;
begin
  select requests.* into v_request
    from public.gateway_requests requests
   where requests.request_id = p_request_id;
  if v_request.request_id is null or v_request.terminal_state is null then
    raise exception using errcode = '23514',
      message = 'gateway usage finalization requires a terminal request';
  end if;
  select attempts.provider, attempts.billing_source,
         coalesce(attempts.input_tokens, 0) as input_tokens,
         coalesce(attempts.output_tokens, 0) as output_tokens
    into v_winning
    from public.gateway_attempts attempts
   where attempts.request_id = p_request_id
   order by attempts.attempt_ordinal desc
   limit 1;
  select pg_catalog.count(*)::pg_catalog.int4,
         coalesce(pg_catalog.sum(
           case attempts.billing_source
             when 'host_managed' then coalesce(attempts.budget_settled_micro_usd, 0)
             else 0
           end), 0),
         coalesce(pg_catalog.sum(
           case attempts.billing_source
             when 'customer_managed' then coalesce(
               attempts.estimated_cost_micro_usd,
               attempts.budget_settled_micro_usd, 0)
             else 0
           end), 0)
    into v_attempt_count, v_cost, v_estimated
    from public.gateway_attempts attempts
   where attempts.request_id = p_request_id;
  select keys.created_by into v_user
    from public.api_keys keys
   where keys.id = v_request.api_key_id;
  insert into public.gateway_usage_events (
    request_id, org_id, api_key_id, user_id, alias, provider, lane,
    input_tokens, output_tokens, cost_micro_usd, estimated_cost_micro_usd,
    latency_ms, status, attempt_count, day
  ) values (
    p_request_id, v_request.org_id, v_request.api_key_id, v_user,
    v_request.alias, v_winning.provider,
    case v_winning.billing_source
      when 'host_managed' then 'platform_funded'
      when 'customer_managed' then 'pass_through'
      else null
    end,
    coalesce(v_winning.input_tokens, 0), coalesce(v_winning.output_tokens, 0),
    v_cost, v_estimated,
    -- Clamped: a caller-supplied deadline more than ~24.8 days out would
    -- otherwise overflow int4 here and wedge every reconcile pass.
    greatest(
      0::pg_catalog.int8,
      least(
        (extract(epoch from (v_request.terminal_at - v_request.accepted_at))
          * 1000)::pg_catalog.int8,
        2147483647::pg_catalog.int8
      )
    )::pg_catalog.int4,
    v_request.terminal_state, coalesce(v_attempt_count, 0),
    (v_request.terminal_at at time zone 'UTC')::pg_catalog.date
  )
  on conflict on constraint gateway_usage_events_pkey do nothing
  returning true into v_inserted;
  if v_inserted then
    insert into public.gateway_usage_daily as daily (
      org_id, user_id, day, alias,
      requests, input_tokens, output_tokens, spend_micro_usd
    ) values (
      v_request.org_id,
      coalesce(v_user, '00000000-0000-0000-0000-000000000000'::pg_catalog.uuid),
      (v_request.terminal_at at time zone 'UTC')::pg_catalog.date,
      v_request.alias,
      1, coalesce(v_winning.input_tokens, 0),
      coalesce(v_winning.output_tokens, 0), v_cost + v_estimated
    )
    on conflict on constraint gateway_usage_daily_pkey do update
      set requests = daily.requests + 1,
          input_tokens = daily.input_tokens + excluded.input_tokens,
          output_tokens = daily.output_tokens + excluded.output_tokens,
          spend_micro_usd = daily.spend_micro_usd + excluded.spend_micro_usd,
          updated_at = pg_catalog.clock_timestamp();
  end if;
end;
$$;

revoke all on function public.gateway_finalize_usage(pg_catalog.text)
  from public, anon, authenticated, service_role;

-- Settle one attempt; optionally terminalize its request, emitting the usage
-- event and rollup in the same transaction. Zero-completion insurance on the
-- platform-funded lane: a terminally failed attempt or one that delivered
-- zero output tokens settles at 0 and releases its reservation (settled
-- attempts leave the outstanding-reservation sum); an unknown-cost attempt
-- bills 0; a mid-stream death ('incomplete'/'cancelled' with output) is
-- charged only the tokens actually delivered.
create function public.gateway_settle_attempt(
  p_attempt_id pg_catalog.text,
  p_state pg_catalog.text,
  p_failure_class pg_catalog.text,
  p_input_tokens pg_catalog.int4,
  p_cached_input_tokens pg_catalog.int4,
  p_output_tokens pg_catalog.int4,
  p_reasoning_tokens pg_catalog.int4,
  p_usage_source pg_catalog.text,
  p_finalize_request pg_catalog.bool
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.gateway_attempts%rowtype;
  v_cost pg_catalog.int8;
  v_settled pg_catalog.int8;
begin
  perform public.gateway_require_service_role();
  if p_state not in ('completed', 'failed', 'cancelled', 'incomplete') then
    raise exception using errcode = '22023',
      message = 'invalid gateway attempt terminal state';
  end if;
  if p_usage_source is null
     or p_usage_source not in ('observed', 'estimated', 'unknown') then
    raise exception using errcode = '22023',
      message = 'invalid gateway attempt usage source';
  end if;
  select attempts.* into v_attempt
    from public.gateway_attempts attempts
   where attempts.attempt_id = p_attempt_id
   for update;
  if v_attempt.attempt_id is null then
    raise exception using errcode = 'P0002',
      message = 'gateway attempt does not exist';
  end if;
  if v_attempt.state <> 'dispatched' then
    if v_attempt.state = p_state then
      -- Replay receipt — but still honor a requested finalize a prior call
      -- skipped (settled finalize=false, then the waterfall ended): without
      -- this the request stays open forever, invisible to both settle and
      -- the reconciler, and its usage event is never emitted.
      if p_finalize_request then
        update public.gateway_requests
           set terminal_state = p_state,
               terminal_at = pg_catalog.clock_timestamp()
         where request_id = v_attempt.request_id
           and terminal_state is null;
        perform public.gateway_finalize_usage(v_attempt.request_id);
      end if;
      return;
    end if;
    raise exception using errcode = '23514',
      message = 'gateway attempt is already settled with another terminal state';
  end if;
  if p_finalize_request then
    -- Take the request lock before the organizations update so the lock
    -- order (request -> organizations) matches gateway_start_attempt;
    -- acquiring them in the opposite order here can deadlock with a
    -- concurrent dispatch of the same request.
    perform 1 from public.gateway_requests requests
     where requests.request_id = v_attempt.request_id
     for update;
  end if;
  v_cost := public.gateway_attempt_cost_micro_usd(
    p_input_tokens, p_cached_input_tokens, p_output_tokens, p_reasoning_tokens,
    v_attempt.input_rate_micro_usd, v_attempt.cached_input_rate_micro_usd,
    v_attempt.output_rate_micro_usd, v_attempt.reasoning_rate_micro_usd
  );
  if v_attempt.billing_source = 'host_managed' then
    v_settled := case
      when p_state = 'failed' or coalesce(p_output_tokens, 0) = 0 then 0
      else coalesce(v_cost, 0)
    end;
  else
    -- Never charged; the conservative attributed value mirrors WMO's ledger.
    v_settled := coalesce(v_cost, v_attempt.budget_reserved_micro_usd);
  end if;
  update public.gateway_attempts
     set state = p_state,
         terminal_at = pg_catalog.clock_timestamp(),
         failure_class = p_failure_class,
         input_tokens = p_input_tokens,
         cached_input_tokens = p_cached_input_tokens,
         output_tokens = p_output_tokens,
         reasoning_tokens = p_reasoning_tokens,
         usage_source = p_usage_source,
         estimated_cost_micro_usd = v_cost,
         budget_settled_micro_usd = v_settled
   where attempt_id = p_attempt_id;
  if v_attempt.billing_source = 'host_managed' then
    perform public.gateway_settle_billing(
      v_attempt.org_id, v_attempt.request_id, p_attempt_id, v_settled
    );
  end if;
  if p_finalize_request then
    update public.gateway_requests
       set terminal_state = p_state,
           terminal_at = pg_catalog.clock_timestamp()
     where request_id = v_attempt.request_id
       and terminal_state is null;
    perform public.gateway_finalize_usage(v_attempt.request_id);
  end if;
end;
$$;

revoke all on function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool
) from public, anon, authenticated;
grant execute on function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool
) to service_role;

-- Terminalize a request that failed before any dispatch (usage event with
-- cost 0 and provider null). Idempotent on a matching terminal state.
create function public.gateway_finish_request(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_terminal_state pg_catalog.text
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.gateway_requests%rowtype;
begin
  perform public.gateway_require_service_role();
  if p_terminal_state not in ('failed', 'cancelled') then
    raise exception using errcode = '22023',
      message = 'invalid gateway request terminal state for pre-dispatch finish';
  end if;
  select requests.* into v_request
    from public.gateway_requests requests
   where requests.request_id = p_request_id
   for update;
  if v_request.request_id is null then
    raise exception using errcode = 'P0002',
      message = 'gateway request was not durably accepted';
  end if;
  if v_request.org_id <> p_org_id then
    raise exception using errcode = '23514',
      message = 'gateway finish authority differs from the accepted request';
  end if;
  if v_request.terminal_state is not null then
    if v_request.terminal_state = p_terminal_state then
      return;
    end if;
    raise exception using errcode = '23514',
      message = 'gateway request is already settled with another terminal state';
  end if;
  update public.gateway_requests
     set terminal_state = p_terminal_state,
         terminal_at = pg_catalog.clock_timestamp()
   where request_id = p_request_id;
  perform public.gateway_finalize_usage(p_request_id);
end;
$$;

revoke all on function public.gateway_finish_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_finish_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text
) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Worker registry write path.

create function public.gateway_worker_heartbeat(
  p_worker_id pg_catalog.text,
  p_state pg_catalog.text,
  p_catalog_sha256 pg_catalog.text,
  p_app_version pg_catalog.text
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  if p_state not in ('starting', 'ready', 'draining', 'dead') then
    raise exception using errcode = '22023',
      message = 'invalid gateway worker state';
  end if;
  insert into public.gateway_workers (
    worker_id, state, catalog_sha256, app_version
  ) values (p_worker_id, p_state, p_catalog_sha256, p_app_version)
  on conflict on constraint gateway_workers_pkey do update
    set state = excluded.state,
        heartbeat_at = pg_catalog.clock_timestamp(),
        catalog_sha256 = excluded.catalog_sha256,
        app_version = excluded.app_version;
end;
$$;

revoke all on function public.gateway_worker_heartbeat(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_worker_heartbeat(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text
) to service_role;

-- ---------------------------------------------------------------------------
-- 12. Crash reconciliation. WMO's per-boot reconciler as an explicitly
--     invoked, advisory-locked function so every-worker scheduling is safe
--     and a booting worker can never corrupt a sibling's live attempts.
--     NEVER called on worker boot.

create function public.gateway_reconcile_crashed(
  p_grace_seconds pg_catalog.int4 default 30
)
returns table (
  expired_requests pg_catalog.int4,
  unknown_attempts pg_catalog.int4
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired pg_catalog.int4 := 0;
  v_unknown pg_catalog.int4 := 0;
  v_request record;
  v_attempt record;
  v_settled pg_catalog.int8;
begin
  perform public.gateway_require_service_role();
  if p_grace_seconds is null or p_grace_seconds < 0 then
    raise exception using errcode = '22023',
      message = 'gateway reconcile grace cannot be negative';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('gateway_reconcile_crashed', 0)
  ) then
    -- A concurrent invocation is already reconciling; skipping is safe and
    -- keeps worker loops from queueing behind one another.
    return query select 0, 0;
    return;
  end if;

  -- Accepted work that never dispatched and passed its deadline.
  for v_request in
    select requests.request_id
      from public.gateway_requests requests
     where requests.terminal_state is null
       and requests.deadline_at <= pg_catalog.clock_timestamp()
       and not exists (
         select 1 from public.gateway_attempts attempts
         where attempts.request_id = requests.request_id
       )
     for update of requests
  loop
    -- Re-check attempt absence in this statement's fresh snapshot: the
    -- cursor's NOT EXISTS ran under an older snapshot, and a concurrent
    -- gateway_start_attempt that held the request lock may have committed a
    -- dispatched attempt while we waited — expiring the request then would
    -- emit the usage event before that attempt's money settles.
    update public.gateway_requests
       set terminal_state = 'expired_before_dispatch',
           terminal_at = pg_catalog.clock_timestamp()
     where request_id = v_request.request_id
       and terminal_state is null
       and not exists (
         select 1 from public.gateway_attempts attempts
         where attempts.request_id = v_request.request_id
       );
    if found then
      perform public.gateway_finalize_usage(v_request.request_id);
      v_expired := v_expired + 1;
    end if;
  end loop;

  -- Dispatched attempts whose worker vanished: unknown outcome. Insurance
  -- settles the platform-funded lane at 0 (reservation released); the
  -- pass-through lane keeps the reserved amount as its attributed estimate.
  for v_attempt in
    select attempts.attempt_id, attempts.request_id, attempts.org_id,
           attempts.billing_source, attempts.budget_reserved_micro_usd
      from public.gateway_attempts attempts
      join public.gateway_requests requests
        on requests.request_id = attempts.request_id
     where attempts.state = 'dispatched'
       and requests.deadline_at
         + pg_catalog.make_interval(secs => p_grace_seconds)
         <= pg_catalog.clock_timestamp()
     for update of attempts
  loop
    v_settled := case v_attempt.billing_source
      when 'host_managed' then 0
      else v_attempt.budget_reserved_micro_usd
    end;
    update public.gateway_attempts
       set state = 'unknown_after_crash',
           terminal_at = pg_catalog.clock_timestamp(),
           usage_source = 'unknown',
           -- The pass-through lane keeps its reserved amount as the
           -- attributed estimate; carrying it in estimated_cost keeps the
           -- usage event's estimated money aligned with the settlement.
           estimated_cost_micro_usd = case v_attempt.billing_source
             when 'customer_managed' then v_attempt.budget_reserved_micro_usd
             else null
           end,
           budget_settled_micro_usd = v_settled
     where attempt_id = v_attempt.attempt_id
       and state = 'dispatched';
    if v_attempt.billing_source = 'host_managed' then
      perform public.gateway_settle_billing(
        v_attempt.org_id, v_attempt.request_id, v_attempt.attempt_id, 0
      );
    end if;
    update public.gateway_requests
       set terminal_state = 'unknown_after_crash',
           terminal_at = pg_catalog.clock_timestamp()
     where request_id = v_attempt.request_id
       and terminal_state is null;
    perform public.gateway_finalize_usage(v_attempt.request_id);
    v_unknown := v_unknown + 1;
  end loop;

  return query select v_expired, v_unknown;
end;
$$;

revoke all on function public.gateway_reconcile_crashed(pg_catalog.int4)
  from public, anon, authenticated;
grant execute on function public.gateway_reconcile_crashed(pg_catalog.int4)
  to service_role;
