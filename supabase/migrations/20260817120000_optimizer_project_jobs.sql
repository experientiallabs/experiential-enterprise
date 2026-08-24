-- Durable execution for organization-owned optimizer Projects.
--
-- New Project jobs deliberately do not reuse the legacy build/routing job tables:
-- their controls allow pause and running cancellation, their writes are not claim
-- fenced, and they execute inside the FastAPI process.  This extension owns a
-- separately deployed worker contract without changing those legacy flows.

create table public.optimizer_project_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.optimizer_projects(id) on delete cascade,
  status text not null default 'queued' check (
    status in ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'ambiguous')
  ),
  workflow_version integer not null default 1 check (workflow_version > 0),
  stage text check (stage is null or stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  progress jsonb not null default '{"message":"Queued"}'::jsonb check (
    jsonb_typeof(progress) = 'object'
    and octet_length(progress::text) <= 8192
    and progress ? 'message'
    and jsonb_typeof(progress -> 'message') = 'string'
    and char_length(progress ->> 'message') between 1 and 500
  ),
  spend_usd numeric(14, 6) not null default 0 check (spend_usd >= 0),
  public_error_code text check (
    public_error_code is null or public_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  public_error_message text check (
    public_error_message is null or char_length(public_error_message) between 1 and 500
  ),
  -- The worker id is diagnostic only.  Every active mutation also matches the
  -- random claim token and monotonically increasing generation.
  worker_id text check (worker_id is null or char_length(worker_id) between 1 and 128),
  claim_token text check (claim_token is null or char_length(claim_token) between 43 and 128),
  claim_generation bigint not null default 0 check (claim_generation >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_event_seq bigint not null default 0 check (last_event_seq >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint optimizer_project_jobs_claim_shape check (
    (
      status in ('claimed', 'running')
      and worker_id is not null
      and claim_token is not null
      and heartbeat_at is not null
      and lease_expires_at is not null
    )
    or (
      status not in ('claimed', 'running')
      and worker_id is null
      and claim_token is null
      and heartbeat_at is null
      and lease_expires_at is null
    )
  ),
  constraint optimizer_project_jobs_terminal_shape check (
    (status in ('completed', 'failed', 'cancelled', 'ambiguous')) = (completed_at is not null)
  ),
  constraint optimizer_project_jobs_public_error_shape check (
    (
      status in ('failed', 'ambiguous')
      and public_error_code is not null
      and public_error_message is not null
    )
    or (
      status not in ('failed', 'ambiguous')
      and public_error_code is null
      and public_error_message is null
    )
  )
);

create unique index optimizer_project_jobs_one_active_per_project
  on public.optimizer_project_jobs (project_id)
  where status in ('queued', 'claimed', 'running');

create unique index optimizer_project_jobs_active_claim_token
  on public.optimizer_project_jobs (claim_token)
  where claim_token is not null;

create index optimizer_project_jobs_claim_queue
  on public.optimizer_project_jobs (available_at, created_at, id)
  where status = 'queued';

create index optimizer_project_jobs_expired_lease
  on public.optimizer_project_jobs (lease_expires_at, id)
  where status in ('claimed', 'running');

create table public.optimizer_project_current_jobs (
  project_id uuid primary key references public.optimizer_projects(id) on delete cascade,
  job_id uuid not null unique references public.optimizer_project_jobs(id) on delete cascade,
  updated_at timestamptz not null default now()
);

-- Per-job sequences are allocated while the owning job row is locked.  Unlike a
-- global identity, that makes cursor order equal commit order even under concurrent
-- writers, so reconnecting after N cannot miss a late commit with a smaller id.
create table public.optimizer_project_job_events (
  job_id uuid not null references public.optimizer_project_jobs(id) on delete cascade,
  seq bigint not null check (seq > 0),
  event_type text not null check (
    event_type in (
      'queued',
      'claimed',
      'requeued',
      'running',
      'progress',
      'spend',
      'stage_started',
      'artifact_proposed',
      'stage_committed',
      'completed',
      'failed',
      'ambiguous',
      'cancelled'
    )
  ),
  stage text check (stage is null or stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192
  ),
  created_at timestamptz not null default now(),
  primary key (job_id, seq)
);

create index optimizer_project_job_events_created_idx
  on public.optimizer_project_job_events (job_id, created_at, seq);

-- A worker first proposes an opaque server-side artifact, then atomically moves
-- the Project's stage pointer to it.  Storage keys never enter public job/event
-- projections; only the kind and content digest do.
create table public.optimizer_project_job_artifact_proposals (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.optimizer_project_jobs(id) on delete cascade,
  project_id uuid not null references public.optimizer_projects(id) on delete cascade,
  stage text not null check (stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  artifact_kind text not null check (artifact_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  storage_key text not null check (
    char_length(storage_key) between 1 and 1024
    and storage_key !~ '(^/|(^|/)\.\.?(/|$))'
    and storage_key !~ '[[:cntrl:]]'
  ),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (job_id, stage),
  unique (id, project_id, job_id)
);

create table public.optimizer_project_stage_pointers (
  project_id uuid not null references public.optimizer_projects(id) on delete cascade,
  stage text not null check (stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  proposal_id uuid not null,
  job_id uuid not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, stage),
  unique (proposal_id),
  foreign key (proposal_id, project_id, job_id)
    references public.optimizer_project_job_artifact_proposals(id, project_id, job_id)
    on delete restrict
);

create index optimizer_project_stage_pointers_job_idx
  on public.optimizer_project_stage_pointers (job_id, stage);

-- Worker presence is an operational health surface.  IDs remain server-internal;
-- the API returns only aggregate live/accepting counts.
create table public.optimizer_project_workers (
  worker_id text primary key check (char_length(worker_id) between 1 and 128),
  accepting_work boolean not null default false,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);

create index optimizer_project_workers_heartbeat_idx
  on public.optimizer_project_workers (heartbeat_at desc);

alter table public.optimizer_project_jobs enable row level security;
alter table public.optimizer_project_current_jobs enable row level security;
alter table public.optimizer_project_job_events enable row level security;
alter table public.optimizer_project_job_artifact_proposals enable row level security;
alter table public.optimizer_project_stage_pointers enable row level security;
alter table public.optimizer_project_workers enable row level security;

revoke all on table public.optimizer_project_jobs from public, anon, authenticated;
revoke all on table public.optimizer_project_current_jobs from public, anon, authenticated;
revoke all on table public.optimizer_project_job_events from public, anon, authenticated;
revoke all on table public.optimizer_project_job_artifact_proposals from public, anon, authenticated;
revoke all on table public.optimizer_project_stage_pointers from public, anon, authenticated;
revoke all on table public.optimizer_project_workers from public, anon, authenticated;

grant all on table public.optimizer_project_jobs to service_role;
grant all on table public.optimizer_project_current_jobs to service_role;
grant all on table public.optimizer_project_job_events to service_role;
grant all on table public.optimizer_project_job_artifact_proposals to service_role;
grant all on table public.optimizer_project_stage_pointers to service_role;
grant all on table public.optimizer_project_workers to service_role;

comment on table public.optimizer_project_jobs is
  'Durable fenced execution attempts for the new organization-owned Project product.';
comment on column public.optimizer_project_jobs.claim_token is
  'Random secret fence. Never serialize this, worker_id, or lease internals to customers.';
comment on table public.optimizer_project_job_events is
  'Bounded customer-safe progress events ordered by a commit-safe per-job sequence.';
comment on table public.optimizer_project_stage_pointers is
  'Latest completed immutable stage boundary per Project, committed only by the active fence.';

-- Allocate and retain one bounded public event tail.  Callers already hold the
-- job row lock before invoking this helper, so sequence allocation is serialized.
create or replace function public.optimizer_project_job_append_event(
  p_job_id uuid,
  p_event_type text,
  p_stage text,
  p_payload jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq bigint;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or pg_catalog.octet_length(p_payload::text) > 8192 then
    raise exception 'invalid public Project job event payload' using errcode = '22023';
  end if;

  update public.optimizer_project_jobs
  set last_event_seq = last_event_seq + 1
  where id = p_job_id
  returning last_event_seq into v_seq;

  if v_seq is null then
    raise exception 'Project job does not exist' using errcode = 'P0002';
  end if;

  insert into public.optimizer_project_job_events (
    job_id,
    seq,
    event_type,
    stage,
    payload
  ) values (
    p_job_id,
    v_seq,
    p_event_type,
    p_stage,
    p_payload
  );

  delete from public.optimizer_project_job_events
  where job_id = p_job_id
    and seq <= v_seq - 512;

  return v_seq;
end;
$$;

revoke all on function public.optimizer_project_job_append_event(uuid, text, text, jsonb)
  from public, anon, authenticated;

create or replace function public.enqueue_optimizer_project_job(p_project_id uuid)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  if not exists (
    select 1 from public.optimizer_projects
    where id = p_project_id and archived_at is null
  ) then
    raise exception 'active Project does not exist' using errcode = 'P0002';
  end if;

  insert into public.optimizer_project_jobs (project_id)
  values (p_project_id)
  returning * into v_job;

  insert into public.optimizer_project_current_jobs (project_id, job_id)
  values (p_project_id, v_job.id)
  on conflict (project_id) do update
  set job_id = excluded.job_id,
      updated_at = pg_catalog.clock_timestamp();

  perform public.optimizer_project_job_append_event(
    v_job.id,
    'queued',
    null,
    pg_catalog.jsonb_build_object('message', 'Project work queued')
  );

  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.claim_optimizer_project_job(
  p_worker_id text,
  p_claim_token text,
  p_lease_seconds integer
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_job public.optimizer_project_jobs%rowtype;
begin
  if p_worker_id is null or pg_catalog.char_length(p_worker_id) not between 1 and 128 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_claim_token is null or pg_catalog.char_length(p_claim_token) not between 43 and 128 then
    raise exception 'invalid claim token' using errcode = '22023';
  end if;
  if p_lease_seconds not between 15 and 3600 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;

  select id into v_job_id
  from public.optimizer_project_jobs
  where status = 'queued'
    and available_at <= pg_catalog.clock_timestamp()
  order by available_at, created_at, id
  for update skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  update public.optimizer_project_jobs
  set status = 'claimed',
      worker_id = p_worker_id,
      claim_token = p_claim_token,
      claim_generation = claim_generation + 1,
      attempt_count = attempt_count + 1,
      heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = v_job_id
  returning * into v_job;

  perform public.optimizer_project_job_append_event(
    v_job.id,
    'claimed',
    v_job.stage,
    pg_catalog.jsonb_build_object('attempt', v_job.attempt_count)
  );

  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.reap_stale_optimizer_project_jobs(p_limit integer default 50)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.optimizer_project_jobs%rowtype;
begin
  if p_limit not between 1 and 500 then
    raise exception 'invalid stale-claim reaper limit' using errcode = '22023';
  end if;

  for v_candidate in
    select *
    from public.optimizer_project_jobs
    where status in ('claimed', 'running')
      and lease_expires_at <= pg_catalog.clock_timestamp()
    order by lease_expires_at, id
    for update skip locked
    limit p_limit
  loop
    update public.optimizer_project_jobs
    set status = 'queued',
        worker_id = null,
        claim_token = null,
        claim_generation = claim_generation + 1,
        heartbeat_at = null,
        lease_expires_at = null,
        available_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    where id = v_candidate.id
      and status in ('claimed', 'running')
      and lease_expires_at <= pg_catalog.clock_timestamp();

    if found then
      perform public.optimizer_project_job_append_event(
        v_candidate.id,
        'requeued',
        v_candidate.stage,
        pg_catalog.jsonb_build_object('reason', 'stale_claim')
      );
      return query select * from public.optimizer_project_jobs where id = v_candidate.id;
    end if;
  end loop;
end;
$$;

create or replace function public.heartbeat_optimizer_project_job(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint,
  p_lease_seconds integer
)
returns setof public.optimizer_project_jobs
language sql
security definer
set search_path = ''
as $$
  update public.optimizer_project_jobs
  set heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status in ('claimed', 'running')
    and lease_expires_at > pg_catalog.clock_timestamp()
    and p_lease_seconds between 15 and 3600
  returning *;
$$;

create or replace function public.start_optimizer_project_job(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint,
  p_stage text,
  p_progress jsonb,
  p_lease_seconds integer
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  if p_stage !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_progress is null
     or pg_catalog.jsonb_typeof(p_progress) <> 'object'
     or pg_catalog.octet_length(p_progress::text) > 8192 then
    raise exception 'invalid Project job start payload' using errcode = '22023';
  end if;

  update public.optimizer_project_jobs
  set status = 'running',
      stage = p_stage,
      progress = p_progress,
      started_at = coalesce(started_at, pg_catalog.clock_timestamp()),
      heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status = 'claimed'
    and lease_expires_at > pg_catalog.clock_timestamp()
    and p_lease_seconds between 15 and 3600
  returning * into v_job;

  if v_job.id is null then
    return;
  end if;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    'running',
    p_stage,
    p_progress
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.update_optimizer_project_job_progress(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint,
  p_stage text,
  p_progress jsonb,
  p_lease_seconds integer
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  if p_stage !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_progress is null
     or pg_catalog.jsonb_typeof(p_progress) <> 'object'
     or pg_catalog.octet_length(p_progress::text) > 8192 then
    raise exception 'invalid Project job progress payload' using errcode = '22023';
  end if;

  update public.optimizer_project_jobs
  set stage = p_stage,
      progress = p_progress,
      heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status = 'running'
    and lease_expires_at > pg_catalog.clock_timestamp()
    and p_lease_seconds between 15 and 3600
  returning * into v_job;

  if v_job.id is null then
    return;
  end if;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    'progress',
    p_stage,
    p_progress
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.record_optimizer_project_job_spend(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint,
  p_spend_usd numeric,
  p_lease_seconds integer
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  update public.optimizer_project_jobs
  set spend_usd = p_spend_usd,
      heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status = 'running'
    and lease_expires_at > pg_catalog.clock_timestamp()
    and p_spend_usd >= spend_usd
    and p_spend_usd >= 0
    and p_lease_seconds between 15 and 3600
  returning * into v_job;

  if v_job.id is null then
    return;
  end if;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    'spend',
    v_job.stage,
    pg_catalog.jsonb_build_object('spend_usd', v_job.spend_usd)
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.append_optimizer_project_job_event(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint,
  p_event_type text,
  p_stage text,
  p_payload jsonb,
  p_lease_seconds integer
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  if p_event_type <> 'stage_started'
     or p_stage !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or pg_catalog.octet_length(p_payload::text) > 8192 then
    raise exception 'invalid Project job domain event' using errcode = '22023';
  end if;

  update public.optimizer_project_jobs
  set stage = p_stage,
      progress = p_payload,
      heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status = 'running'
    and lease_expires_at > pg_catalog.clock_timestamp()
    and p_lease_seconds between 15 and 3600
  returning * into v_job;

  if v_job.id is null then
    return;
  end if;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    p_event_type,
    p_stage,
    p_payload
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.propose_optimizer_project_job_artifact(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint,
  p_stage text,
  p_artifact_kind text,
  p_storage_key text,
  p_sha256 text,
  p_lease_seconds integer
)
returns setof public.optimizer_project_job_artifact_proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
  v_proposal public.optimizer_project_job_artifact_proposals%rowtype;
begin
  select * into v_job
  from public.optimizer_project_jobs job
  where job.id = p_job_id
    and job.claim_token = p_claim_token
    and job.claim_generation = p_claim_generation
    and job.status = 'running'
    and job.stage = p_stage
    and job.lease_expires_at > pg_catalog.clock_timestamp()
  for update;

  if v_job.id is null or p_lease_seconds not between 15 and 3600 then
    return;
  end if;

  select * into v_proposal
  from public.optimizer_project_job_artifact_proposals
  where job_id = p_job_id and stage = p_stage;

  if v_proposal.id is null then
    insert into public.optimizer_project_job_artifact_proposals (
      job_id,
      project_id,
      stage,
      artifact_kind,
      storage_key,
      sha256
    ) values (
      p_job_id,
      v_job.project_id,
      p_stage,
      p_artifact_kind,
      p_storage_key,
      p_sha256
    ) returning * into v_proposal;
  elsif v_proposal.artifact_kind <> p_artifact_kind
     or v_proposal.storage_key <> p_storage_key
     or v_proposal.sha256 <> p_sha256 then
    raise exception 'immutable Project artifact proposal differs on replay'
      using errcode = '23505';
  end if;

  update public.optimizer_project_jobs
  set heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id;

  perform public.optimizer_project_job_append_event(
    p_job_id,
    'artifact_proposed',
    p_stage,
    pg_catalog.jsonb_build_object('artifact_kind', p_artifact_kind, 'sha256', p_sha256)
  );
  return next v_proposal;
end;
$$;

create or replace function public.commit_optimizer_project_stage_pointer(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint,
  p_proposal_id uuid,
  p_lease_seconds integer
)
returns setof public.optimizer_project_stage_pointers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
  v_proposal public.optimizer_project_job_artifact_proposals%rowtype;
  v_pointer public.optimizer_project_stage_pointers%rowtype;
begin
  select * into v_job
  from public.optimizer_project_jobs
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status = 'running'
    and lease_expires_at > pg_catalog.clock_timestamp()
  for update;

  if v_job.id is null or p_lease_seconds not between 15 and 3600 then
    return;
  end if;

  select * into v_proposal
  from public.optimizer_project_job_artifact_proposals
  where id = p_proposal_id
    and job_id = p_job_id
    and project_id = v_job.project_id
    and stage = v_job.stage;

  if v_proposal.id is null then
    raise exception 'artifact proposal does not belong to active Project job'
      using errcode = 'P0002';
  end if;

  insert into public.optimizer_project_stage_pointers (
    project_id,
    stage,
    proposal_id,
    job_id,
    sha256
  ) values (
    v_job.project_id,
    v_proposal.stage,
    v_proposal.id,
    v_job.id,
    v_proposal.sha256
  )
  on conflict (project_id, stage) do update
  set proposal_id = excluded.proposal_id,
      job_id = excluded.job_id,
      sha256 = excluded.sha256,
      updated_at = pg_catalog.clock_timestamp()
  returning * into v_pointer;

  update public.optimizer_project_jobs
  set heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id;

  perform public.optimizer_project_job_append_event(
    p_job_id,
    'stage_committed',
    v_proposal.stage,
    pg_catalog.jsonb_build_object(
      'artifact_kind', v_proposal.artifact_kind,
      'sha256', v_proposal.sha256
    )
  );
  return next v_pointer;
end;
$$;

create or replace function public.release_optimizer_project_job_claim(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  update public.optimizer_project_jobs job
  set status = 'queued',
      worker_id = null,
      claim_token = null,
      claim_generation = claim_generation + 1,
      heartbeat_at = null,
      lease_expires_at = null,
      available_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where job.id = p_job_id
    and job.claim_token = p_claim_token
    and job.claim_generation = p_claim_generation
    and job.status = 'running'
    and job.lease_expires_at > pg_catalog.clock_timestamp()
    and exists (
      select 1 from public.optimizer_project_stage_pointers pointer
      where pointer.project_id = job.project_id
        and pointer.job_id = job.id
        and pointer.stage = job.stage
    )
  returning * into v_job;

  if v_job.id is null then
    return;
  end if;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    'requeued',
    v_job.stage,
    pg_catalog.jsonb_build_object('reason', 'worker_shutdown_at_stage_boundary')
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.finish_optimizer_project_job(
  p_job_id uuid,
  p_claim_token text,
  p_claim_generation bigint,
  p_status text,
  p_public_error_code text,
  p_public_error_message text
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
  v_payload jsonb;
begin
  if p_status not in ('completed', 'failed', 'ambiguous') then
    raise exception 'invalid Project job terminal state' using errcode = '22023';
  end if;
  if p_status = 'completed'
     and (p_public_error_code is not null or p_public_error_message is not null) then
    raise exception 'completed Project job cannot carry an error' using errcode = '22023';
  end if;

  update public.optimizer_project_jobs
  set status = p_status,
      public_error_code = p_public_error_code,
      public_error_message = p_public_error_message,
      worker_id = null,
      claim_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status in ('claimed', 'running')
    and lease_expires_at > pg_catalog.clock_timestamp()
  returning * into v_job;

  if v_job.id is null then
    return;
  end if;

  v_payload := case
    when p_status = 'completed' then
      pg_catalog.jsonb_build_object('message', 'Project work completed')
    else pg_catalog.jsonb_build_object(
      'error_code', p_public_error_code,
      'message', p_public_error_message
    )
  end;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    p_status,
    v_job.stage,
    v_payload
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.cancel_queued_optimizer_project_job(p_job_id uuid)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  update public.optimizer_project_jobs
  set status = 'cancelled',
      completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id and status = 'queued'
  returning * into v_job;

  if v_job.id is null then
    return;
  end if;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    'cancelled',
    v_job.stage,
    pg_catalog.jsonb_build_object('message', 'Queued Project work cancelled')
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.heartbeat_optimizer_project_worker(
  p_worker_id text,
  p_accepting_work boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or pg_catalog.char_length(p_worker_id) not between 1 and 128 then
    raise exception 'invalid Project worker id' using errcode = '22023';
  end if;
  insert into public.optimizer_project_workers (
    worker_id,
    accepting_work,
    heartbeat_at
  ) values (
    p_worker_id,
    p_accepting_work,
    pg_catalog.clock_timestamp()
  )
  on conflict (worker_id) do update
  set accepting_work = excluded.accepting_work,
      heartbeat_at = excluded.heartbeat_at;
end;
$$;

create or replace function public.stop_optimizer_project_worker(p_worker_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.optimizer_project_workers
  where worker_id = p_worker_id;
$$;

revoke all on function public.enqueue_optimizer_project_job(uuid)
  from public, anon, authenticated;
revoke all on function public.claim_optimizer_project_job(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.reap_stale_optimizer_project_jobs(integer)
  from public, anon, authenticated;
revoke all on function public.heartbeat_optimizer_project_job(uuid, text, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.start_optimizer_project_job(uuid, text, bigint, text, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.update_optimizer_project_job_progress(uuid, text, bigint, text, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.record_optimizer_project_job_spend(uuid, text, bigint, numeric, integer)
  from public, anon, authenticated;
revoke all on function public.append_optimizer_project_job_event(uuid, text, bigint, text, text, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.propose_optimizer_project_job_artifact(uuid, text, bigint, text, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.commit_optimizer_project_stage_pointer(uuid, text, bigint, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_optimizer_project_job_claim(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.finish_optimizer_project_job(uuid, text, bigint, text, text, text)
  from public, anon, authenticated;
revoke all on function public.cancel_queued_optimizer_project_job(uuid)
  from public, anon, authenticated;
revoke all on function public.heartbeat_optimizer_project_worker(text, boolean)
  from public, anon, authenticated;
revoke all on function public.stop_optimizer_project_worker(text)
  from public, anon, authenticated;

grant execute on function public.enqueue_optimizer_project_job(uuid) to service_role;
grant execute on function public.claim_optimizer_project_job(text, text, integer) to service_role;
grant execute on function public.reap_stale_optimizer_project_jobs(integer) to service_role;
grant execute on function public.heartbeat_optimizer_project_job(uuid, text, bigint, integer)
  to service_role;
grant execute on function public.start_optimizer_project_job(uuid, text, bigint, text, jsonb, integer)
  to service_role;
grant execute on function public.update_optimizer_project_job_progress(uuid, text, bigint, text, jsonb, integer)
  to service_role;
grant execute on function public.record_optimizer_project_job_spend(uuid, text, bigint, numeric, integer)
  to service_role;
grant execute on function public.append_optimizer_project_job_event(uuid, text, bigint, text, text, jsonb, integer)
  to service_role;
grant execute on function public.propose_optimizer_project_job_artifact(uuid, text, bigint, text, text, text, text, integer)
  to service_role;
grant execute on function public.commit_optimizer_project_stage_pointer(uuid, text, bigint, uuid, integer)
  to service_role;
grant execute on function public.release_optimizer_project_job_claim(uuid, text, bigint)
  to service_role;
grant execute on function public.finish_optimizer_project_job(uuid, text, bigint, text, text, text)
  to service_role;
grant execute on function public.cancel_queued_optimizer_project_job(uuid) to service_role;
grant execute on function public.heartbeat_optimizer_project_worker(text, boolean) to service_role;
grant execute on function public.stop_optimizer_project_worker(text) to service_role;
