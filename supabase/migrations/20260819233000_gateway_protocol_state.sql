-- Durable protocol state for the WMO gateway: idempotency replay and Responses
-- continuations, shared across workers so restarts and cross-worker retries
-- keep working (WMO's bundled stores are process-local and bounded).
--
-- RETENTION DECISION (deliberate exception to the gateway's content-free
-- posture): both stores are content-bearing BY CONTRACT. Replay must return
-- the exact completed HTTP response bytes, and a continuation must return the
-- caller's prior canonical messages — there is no content-free implementation
-- of either seam. The content lives ONLY in these two tables, never in the
-- content-free ledger tables (whose content_retained = 0 checks are
-- untouched), is capped at 4 MiB per entry, and expires after a finite TTL
-- (24h at the worker composition); expired rows are pruned inside every write
-- path. Nothing besides the two worker adapters reads these tables.
--
-- Ownership model for replay: exactly one owner token per unpublished
-- operation. An owner that vanishes (worker loss) leaves a lease that expires
-- within lease_seconds, after which a new claimant takes over ownership and
-- waiting joiners fail closed — joiners can never wait forever.

create table public.gateway_replay_operations (
  -- WMO protocol-namespace identifiers (opaque artifact ids, e.g. org-<uuid>).
  organization_id pg_catalog.text not null check (
    pg_catalog.char_length(organization_id) between 1 and 128
  ),
  identity_id pg_catalog.text not null check (
    pg_catalog.char_length(identity_id) between 1 and 128
  ),
  alias_revision_id pg_catalog.text not null check (
    pg_catalog.char_length(alias_revision_id) between 1 and 128
  ),
  api_surface pg_catalog.text not null check (
    api_surface in ('chat_completions', 'responses')
  ),
  caller_operation_sha256 pg_catalog.text not null check (
    caller_operation_sha256 ~ '^[0-9a-f]{64}$'
  ),
  canonical_request_sha256 pg_catalog.text not null check (
    canonical_request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  -- Rotates on every ownership grant; publication requires the exact token.
  owner_token pg_catalog.uuid not null,
  state pg_catalog.text not null check (state in ('claimed', 'published')),
  claimed_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  lease_expires_at pg_catalog.timestamptz not null,
  published_at pg_catalog.timestamptz,
  -- Retention deadline once published.
  expires_at pg_catalog.timestamptz,
  response_status pg_catalog.int4 check (
    response_status is null or response_status between 100 and 599
  ),
  response_media_type pg_catalog.text check (
    response_media_type is null
    or pg_catalog.char_length(response_media_type) between 1 and 256
  ),
  response_headers pg_catalog.jsonb check (
    response_headers is null
    or pg_catalog.jsonb_typeof(response_headers) = 'array'
  ),
  response_body pg_catalog.bytea check (
    response_body is null or pg_catalog.octet_length(response_body) <= 4194304
  ),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (
    organization_id, identity_id, alias_revision_id,
    api_surface, caller_operation_sha256
  ),
  check (
    (state = 'published')
    = (
      response_status is not null and response_media_type is not null
      and response_headers is not null and response_body is not null
      and published_at is not null and expires_at is not null
    )
  )
);

create index gateway_replay_operations_expiry_idx
  on public.gateway_replay_operations (coalesce(expires_at, lease_expires_at));

comment on table public.gateway_replay_operations is
  'Cross-worker idempotency replay: one row per keyed operation, holding the exact published response (content-bearing BY CONTRACT, 4 MiB cap, finite TTL). Written only by the gateway_replay_* functions.';

create table public.gateway_continuations (
  organization_id pg_catalog.text not null check (
    pg_catalog.char_length(organization_id) between 1 and 128
  ),
  identity_id pg_catalog.text not null check (
    pg_catalog.char_length(identity_id) between 1 and 128
  ),
  alias_revision_id pg_catalog.text not null check (
    pg_catalog.char_length(alias_revision_id) between 1 and 128
  ),
  response_id pg_catalog.text not null check (
    pg_catalog.char_length(response_id) between 1 and 256
    and response_id !~ '[[:cntrl:]]'
  ),
  episode_key pg_catalog.text not null check (episode_key ~ '^[0-9a-f]{64}$'),
  -- Canonical GatewayMessage array (content-bearing BY CONTRACT, 4 MiB cap).
  messages pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(messages) = 'array'
    and pg_catalog.octet_length(messages::pg_catalog.text) <= 4194304
  ),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at pg_catalog.timestamptz not null,
  primary key (organization_id, identity_id, alias_revision_id, response_id)
);

create index gateway_continuations_expiry_idx
  on public.gateway_continuations (expires_at);

comment on table public.gateway_continuations is
  'Cross-worker Responses continuations: canonical prior messages per public response id (content-bearing BY CONTRACT, 4 MiB cap, finite TTL). Written only by gateway_continuation_remember.';

alter table public.gateway_replay_operations enable row level security;
alter table public.gateway_continuations enable row level security;

revoke all on table public.gateway_replay_operations
  from public, anon, authenticated, service_role;
revoke all on table public.gateway_continuations
  from public, anon, authenticated, service_role;

grant select on table public.gateway_replay_operations to service_role;
grant select on table public.gateway_continuations to service_role;

-- ---------------------------------------------------------------------------
-- Replay write paths.

-- Claim one keyed operation: 'owner' (do the work), 'join' (wait for the
-- owner), 'replay' (published response returned inline), or 'conflict'
-- (caller operation reused with a different canonical body; the worker maps
-- it to the protocol 409). A lease-expired unpublished row is taken over by
-- the new claimant regardless of body: its owner is gone and never published,
-- so the new request is the operation's only live authority.
create function public.gateway_replay_claim(
  p_organization_id pg_catalog.text,
  p_identity_id pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_api_surface pg_catalog.text,
  p_caller_operation_sha256 pg_catalog.text,
  p_canonical_request_sha256 pg_catalog.text,
  p_owner_token pg_catalog.uuid,
  p_lease_seconds pg_catalog.int4
)
returns table (
  kind pg_catalog.text,
  response_status pg_catalog.int4,
  response_media_type pg_catalog.text,
  response_headers pg_catalog.jsonb,
  response_body pg_catalog.bytea
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.gateway_replay_operations%rowtype;
begin
  perform public.gateway_require_service_role();
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception using errcode = '22023',
      message = 'gateway replay lease must be positive';
  end if;
  -- Finite retention: prune published rows past their TTL.
  delete from public.gateway_replay_operations operations
   where operations.state = 'published'
     and operations.expires_at <= pg_catalog.clock_timestamp();

  select operations.* into v_row
    from public.gateway_replay_operations operations
   where operations.organization_id = p_organization_id
     and operations.identity_id = p_identity_id
     and operations.alias_revision_id = p_alias_revision_id
     and operations.api_surface = p_api_surface
     and operations.caller_operation_sha256 = p_caller_operation_sha256
   for update;

  if v_row.caller_operation_sha256 is null then
    insert into public.gateway_replay_operations (
      organization_id, identity_id, alias_revision_id, api_surface,
      caller_operation_sha256, canonical_request_sha256, owner_token,
      state, lease_expires_at
    ) values (
      p_organization_id, p_identity_id, p_alias_revision_id, p_api_surface,
      p_caller_operation_sha256, p_canonical_request_sha256, p_owner_token,
      'claimed',
      pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds)
    );
    return query select 'owner'::pg_catalog.text,
      null::pg_catalog.int4, null::pg_catalog.text,
      null::pg_catalog.jsonb, null::pg_catalog.bytea;
    return;
  end if;

  if v_row.state = 'claimed'
     and v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    update public.gateway_replay_operations
       set canonical_request_sha256 = p_canonical_request_sha256,
           owner_token = p_owner_token,
           claimed_at = pg_catalog.clock_timestamp(),
           lease_expires_at = pg_catalog.clock_timestamp()
             + pg_catalog.make_interval(secs => p_lease_seconds)
     where organization_id = p_organization_id
       and identity_id = p_identity_id
       and alias_revision_id = p_alias_revision_id
       and api_surface = p_api_surface
       and caller_operation_sha256 = p_caller_operation_sha256;
    return query select 'owner'::pg_catalog.text,
      null::pg_catalog.int4, null::pg_catalog.text,
      null::pg_catalog.jsonb, null::pg_catalog.bytea;
    return;
  end if;

  if v_row.canonical_request_sha256 <> p_canonical_request_sha256 then
    return query select 'conflict'::pg_catalog.text,
      null::pg_catalog.int4, null::pg_catalog.text,
      null::pg_catalog.jsonb, null::pg_catalog.bytea;
    return;
  end if;

  if v_row.state = 'published' then
    return query select 'replay'::pg_catalog.text,
      v_row.response_status, v_row.response_media_type,
      v_row.response_headers, v_row.response_body;
    return;
  end if;

  return query select 'join'::pg_catalog.text,
    null::pg_catalog.int4, null::pg_catalog.text,
    null::pg_catalog.jsonb, null::pg_catalog.bytea;
end;
$$;

revoke all on function public.gateway_replay_claim(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_replay_claim(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4
) to service_role;

-- Publish the owner's exact response. Returns false when this token no longer
-- owns unpublished work (lease taken over, abandoned, or already published).
create function public.gateway_replay_publish(
  p_organization_id pg_catalog.text,
  p_identity_id pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_api_surface pg_catalog.text,
  p_caller_operation_sha256 pg_catalog.text,
  p_owner_token pg_catalog.uuid,
  p_response_status pg_catalog.int4,
  p_response_media_type pg_catalog.text,
  p_response_headers pg_catalog.jsonb,
  p_response_body pg_catalog.bytea,
  p_ttl_seconds pg_catalog.int4
)
returns table (published pg_catalog.bool)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count pg_catalog.int4;
begin
  perform public.gateway_require_service_role();
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception using errcode = '22023',
      message = 'gateway replay retention must be positive';
  end if;
  update public.gateway_replay_operations
     set state = 'published',
         published_at = pg_catalog.clock_timestamp(),
         expires_at = pg_catalog.clock_timestamp()
           + pg_catalog.make_interval(secs => p_ttl_seconds),
         response_status = p_response_status,
         response_media_type = p_response_media_type,
         response_headers = p_response_headers,
         response_body = p_response_body
   where organization_id = p_organization_id
     and identity_id = p_identity_id
     and alias_revision_id = p_alias_revision_id
     and api_surface = p_api_surface
     and caller_operation_sha256 = p_caller_operation_sha256
     and owner_token = p_owner_token
     and state = 'claimed';
  get diagnostics v_count = row_count;
  return query select v_count = 1;
end;
$$;

revoke all on function public.gateway_replay_publish(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.int4, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.bytea, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_replay_publish(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.int4, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.bytea, pg_catalog.int4
) to service_role;

-- Release failed owner work so no joiner receives invented response content.
-- Idempotent; a published row is never erased.
create function public.gateway_replay_abandon(
  p_organization_id pg_catalog.text,
  p_identity_id pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_api_surface pg_catalog.text,
  p_caller_operation_sha256 pg_catalog.text,
  p_owner_token pg_catalog.uuid
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  delete from public.gateway_replay_operations
   where organization_id = p_organization_id
     and identity_id = p_identity_id
     and alias_revision_id = p_alias_revision_id
     and api_surface = p_api_surface
     and caller_operation_sha256 = p_caller_operation_sha256
     and owner_token = p_owner_token
     and state = 'claimed';
end;
$$;

revoke all on function public.gateway_replay_abandon(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.gateway_replay_abandon(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Continuation write path. Reads are plain SELECTs (expiry enforced by the
-- worker adapter, which fails closed on missing or expired rows).

create function public.gateway_continuation_remember(
  p_organization_id pg_catalog.text,
  p_identity_id pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_response_id pg_catalog.text,
  p_episode_key pg_catalog.text,
  p_messages pg_catalog.jsonb,
  p_ttl_seconds pg_catalog.int4
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception using errcode = '22023',
      message = 'gateway continuation retention must be positive';
  end if;
  -- Finite retention: prune expired rows on every write.
  delete from public.gateway_continuations continuations
   where continuations.expires_at <= pg_catalog.clock_timestamp();
  insert into public.gateway_continuations (
    organization_id, identity_id, alias_revision_id, response_id,
    episode_key, messages, expires_at
  ) values (
    p_organization_id, p_identity_id, p_alias_revision_id, p_response_id,
    p_episode_key, p_messages,
    pg_catalog.clock_timestamp()
      + pg_catalog.make_interval(secs => p_ttl_seconds)
  )
  on conflict on constraint gateway_continuations_pkey do update
    set episode_key = excluded.episode_key,
        messages = excluded.messages,
        expires_at = excluded.expires_at;
end;
$$;

revoke all on function public.gateway_continuation_remember(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_continuation_remember(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4
) to service_role;
