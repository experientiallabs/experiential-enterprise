-- Project-scoped trace acquisition. Platform owns acquiring immutable bytes;
-- WMO owns interpreting those bytes in PR 9. The tables are server-only so
-- connection ids, opaque cursors, and Storage locations never become a Data
-- API surface. Customer-safe views are projected by FastAPI.

-- The duplicated org id on extension rows is a query/audit field, not a
-- second source of truth. This key lets every extension table prove that its
-- Project and organization are the same ownership pair.
alter table public.optimizer_projects
  add constraint optimizer_projects_trace_scope_key unique (id, org_id);

create table public.optimizer_project_trace_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  org_id uuid not null references public.organizations(id),
  source_kind text not null check (
    source_kind in (
      'braintrust',
      'chat-json',
      'langfuse',
      'langsmith',
      'mastra',
      'otel-genai',
      'otlp',
      'phoenix',
      'posthog'
    )
  ),
  source_label text not null check (
    char_length(btrim(source_label)) between 1 and 200
  ),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size between 1 and 52428800),
  content_type text not null check (char_length(btrim(content_type)) between 1 and 255),
  record_count_estimate integer not null check (record_count_estimate >= 0),
  acquired_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint optimizer_project_trace_sources_project_content_key
    unique (project_id, source_kind, sha256),
  constraint optimizer_project_trace_sources_identity_scope_key
    unique (id, project_id, org_id),
  constraint optimizer_project_trace_sources_project_scope_fkey
    foreign key (project_id, org_id)
    references public.optimizer_projects(id, org_id)
);

comment on table public.optimizer_project_trace_sources is
  'Immutable customer-safe metadata for Project trace bytes acquired by Platform.';
comment on column public.optimizer_project_trace_sources.source_label is
  'Durable customer-safe label passed to WMO; never a worker-local path.';

create index optimizer_project_trace_sources_project_created_idx
  on public.optimizer_project_trace_sources (project_id, created_at desc, id desc);
create index optimizer_project_trace_sources_org_id_idx
  on public.optimizer_project_trace_sources (org_id);

-- Storage coordinates are deliberately isolated from source metadata. Even a
-- future direct SELECT grant on the metadata table cannot reveal bucket paths.
create table public.optimizer_project_trace_source_objects (
  source_id uuid primary key references public.optimizer_project_trace_sources(id),
  storage_bucket text not null check (char_length(btrim(storage_bucket)) between 1 and 255),
  storage_path text not null check (
    char_length(btrim(storage_path)) between 1 and 1024
    and storage_path !~ '(^|/)\.\.(/|$)'
    and storage_path !~ '^/'
  ),
  created_at timestamptz not null default now(),
  constraint optimizer_project_trace_source_objects_location_key
    unique (storage_bucket, storage_path)
);

comment on table public.optimizer_project_trace_source_objects is
  'Service-only object locators for immutable Project trace-source bytes.';

create table public.optimizer_project_trace_acquisitions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  org_id uuid not null references public.organizations(id),
  source_kind text not null check (
    source_kind in (
      'braintrust',
      'chat-json',
      'langfuse',
      'langsmith',
      'mastra',
      'otel-genai',
      'otlp',
      'phoenix',
      'posthog'
    )
  ),
  transport_kind text not null check (
    transport_kind in (
      'upload',
      'langfuse',
      'langsmith',
      'braintrust',
      'posthog',
      'mastra',
      'postgres'
    )
  ),
  source_label text not null check (
    char_length(btrim(source_label)) between 1 and 200
  ),
  source_config jsonb not null default '{}'::jsonb,
  connection_id uuid references public.trace_connections(id) on delete set null,
  state text not null default 'pending' check (
    state in ('pending', 'acquiring', 'succeeded', 'failed')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor) = 'object'),
  records_acquired integer not null default 0 check (records_acquired >= 0),
  max_records integer check (max_records between 1 and 1000),
  since_at timestamptz,
  byte_size bigint check (byte_size between 0 and 52428800),
  error_code text check (
    error_code is null or error_code in (
      'bad_credentials',
      'connection_missing',
      'invalid_source_config',
      'invalid_source_response',
      'object_too_large',
      'rate_limited',
      'source_timeout',
      'source_unavailable',
      'storage_failed'
    )
  ),
  source_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint optimizer_project_trace_acquisitions_source_scope_fkey
    foreign key (source_id, project_id, org_id)
    references public.optimizer_project_trace_sources(id, project_id, org_id),
  constraint optimizer_project_trace_acquisitions_project_scope_fkey
    foreign key (project_id, org_id)
    references public.optimizer_projects(id, org_id),
  constraint optimizer_project_trace_acquisitions_request_shape_check check (
    (
      transport_kind = 'upload'
      and connection_id is null
      and source_config = '{}'::jsonb
      and max_records is null
      and since_at is null
    )
    or (transport_kind <> 'upload' and max_records is not null)
  ),
  constraint optimizer_project_trace_acquisitions_source_config_object_check check (
    jsonb_typeof(source_config) = 'object'
  ),
  constraint optimizer_project_trace_acquisitions_transport_source_config_check check (
    (transport_kind = 'postgres' and source_config <> '{}'::jsonb)
    or (transport_kind <> 'postgres' and source_config = '{}'::jsonb)
  ),
  constraint optimizer_project_trace_acquisitions_transport_format_check check (
    transport_kind in ('upload', 'postgres')
    or transport_kind = source_kind
  ),
  constraint optimizer_project_trace_acquisitions_state_attempt_count_check check (
    (state = 'pending' and attempt_count = 0)
    or (state <> 'pending' and attempt_count >= 1)
  ),
  constraint optimizer_project_trace_acquisitions_terminal_shape_check check (
    (state = 'succeeded' and source_id is not null and error_code is null)
    or (state = 'failed' and source_id is null and error_code is not null)
    or (state in ('pending', 'acquiring') and source_id is null and error_code is null)
  )
);

create index optimizer_project_trace_acquisitions_project_created_idx
  on public.optimizer_project_trace_acquisitions (project_id, created_at desc, id desc);
create index optimizer_project_trace_acquisitions_connection_id_idx
  on public.optimizer_project_trace_acquisitions (connection_id)
  where connection_id is not null;

create table public.optimizer_project_trace_current_sources (
  project_id uuid primary key,
  org_id uuid not null references public.organizations(id),
  source_id uuid not null,
  selected_at timestamptz not null default now(),
  constraint optimizer_project_trace_current_sources_source_scope_fkey
    foreign key (source_id, project_id, org_id)
    references public.optimizer_project_trace_sources(id, project_id, org_id),
  constraint optimizer_project_trace_current_sources_project_scope_fkey
    foreign key (project_id, org_id)
    references public.optimizer_projects(id, org_id)
);

comment on table public.optimizer_project_trace_current_sources is
  'Mutable current-source pointer; source rows and bytes remain immutable history.';

create or replace function public.reject_optimizer_project_trace_source_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'optimizer Project trace sources are immutable';
end;
$$;

create trigger optimizer_project_trace_sources_immutable
before update or delete on public.optimizer_project_trace_sources
for each row execute function public.reject_optimizer_project_trace_source_mutation();

create trigger optimizer_project_trace_source_objects_immutable
before update or delete on public.optimizer_project_trace_source_objects
for each row execute function public.reject_optimizer_project_trace_source_mutation();

-- Registering a source spans immutable metadata, its private locator, the
-- mutable current pointer, and the terminal acquisition state. Keep that
-- boundary atomic instead of asking the Data API client to emulate a
-- transaction across four HTTP writes.
create or replace function public.register_optimizer_project_trace_source(
  in_acquisition_id uuid,
  in_project_id uuid,
  in_org_id uuid,
  in_source_kind text,
  in_source_label text,
  in_sha256 text,
  in_byte_size bigint,
  in_content_type text,
  in_record_count_estimate integer,
  in_storage_bucket text,
  in_storage_path text
)
returns setof public.optimizer_project_trace_sources
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquisition public.optimizer_project_trace_acquisitions%rowtype;
  source public.optimizer_project_trace_sources%rowtype;
  inserted boolean := false;
begin
  select *
  into acquisition
  from public.optimizer_project_trace_acquisitions
  where id = in_acquisition_id
    and project_id = in_project_id
    and org_id = in_org_id
    and source_kind = in_source_kind
    and source_label = in_source_label
    and state = 'acquiring'
  for update;

  if not found then
    raise exception 'trace acquisition is not claimable for source registration';
  end if;

  insert into public.optimizer_project_trace_sources (
    project_id,
    org_id,
    source_kind,
    source_label,
    sha256,
    byte_size,
    content_type,
    record_count_estimate
  ) values (
    in_project_id,
    in_org_id,
    in_source_kind,
    in_source_label,
    in_sha256,
    in_byte_size,
    in_content_type,
    in_record_count_estimate
  )
  on conflict (project_id, source_kind, sha256) do nothing
  returning * into source;

  inserted := found;

  if inserted then

    insert into public.optimizer_project_trace_source_objects (
      source_id,
      storage_bucket,
      storage_path
    ) values (
      source.id,
      in_storage_bucket,
      in_storage_path
    );
  else
    select *
    into source
    from public.optimizer_project_trace_sources
    where project_id = in_project_id
      and source_kind = in_source_kind
      and sha256 = in_sha256;

    if not found
      or source.org_id <> in_org_id
      or source.byte_size <> in_byte_size
      or source.record_count_estimate <> in_record_count_estimate then
      raise exception 'deduplicated trace source metadata does not match';
    end if;
  end if;

  insert into public.optimizer_project_trace_current_sources (
    project_id,
    org_id,
    source_id,
    selected_at
  ) values (
    in_project_id,
    in_org_id,
    source.id,
    now()
  )
  on conflict (project_id) do update
  set org_id = excluded.org_id,
      source_id = excluded.source_id,
      selected_at = excluded.selected_at;

  update public.optimizer_project_trace_acquisitions
  set state = 'succeeded',
      cursor = '{"complete": true}'::jsonb,
      records_acquired = in_record_count_estimate,
      byte_size = in_byte_size,
      error_code = null,
      source_id = source.id,
      completed_at = now(),
      updated_at = now()
  where id = acquisition.id;

  return next source;
end;
$$;

-- These tables contain service-internal handles. Keep RLS as defense in depth
-- and opt only service_role into the Data API after Supabase's 2026 explicit-
-- grant change; org authorization remains in the FastAPI boundary.
alter table public.optimizer_project_trace_sources enable row level security;
alter table public.optimizer_project_trace_source_objects enable row level security;
alter table public.optimizer_project_trace_acquisitions enable row level security;
alter table public.optimizer_project_trace_current_sources enable row level security;

revoke all on table public.optimizer_project_trace_sources from anon, authenticated;
revoke all on table public.optimizer_project_trace_source_objects from anon, authenticated;
revoke all on table public.optimizer_project_trace_acquisitions from anon, authenticated;
revoke all on table public.optimizer_project_trace_current_sources from anon, authenticated;

grant select, insert on table public.optimizer_project_trace_sources to service_role;
grant select, insert on table public.optimizer_project_trace_source_objects to service_role;
grant select, insert, update on table public.optimizer_project_trace_acquisitions to service_role;
grant select, insert, update on table public.optimizer_project_trace_current_sources to service_role;

revoke all on function public.reject_optimizer_project_trace_source_mutation()
  from public, anon, authenticated;
grant execute on function public.reject_optimizer_project_trace_source_mutation()
  to service_role;

revoke all on function public.register_optimizer_project_trace_source(
  uuid, uuid, uuid, text, text, text, bigint, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.register_optimizer_project_trace_source(
  uuid, uuid, uuid, text, text, text, bigint, text, integer, text, text
) to service_role;
