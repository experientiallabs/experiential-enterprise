-- A bare `wmh run` uses the CLI's built-in pi harness rather than a persisted
-- platform agent. It still needs an auditable org-scoped usage row when login
-- credentials supply worker completions, so it cannot be forced into the
-- agent_sessions table (which correctly requires an agent_id).
create table public.local_pi_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid,
  status text not null default 'running' check (status in ('running', 'ended', 'failed')),
  worker_provider text not null,
  worker_model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  llm_calls int not null default 0,
  cost_usd numeric(12, 6),
  ended_reason text,
  error text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create index local_pi_runs_org_created_idx
  on public.local_pi_runs (org_id, created_at desc);

alter table public.local_pi_runs enable row level security;

create policy local_pi_runs_select_member
  on public.local_pi_runs
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

create function public.increment_local_pi_run_usage(
  in_run uuid,
  in_input_tokens bigint,
  in_output_tokens bigint,
  in_cost numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.local_pi_runs
     set input_tokens = input_tokens + coalesce(in_input_tokens, 0),
         output_tokens = output_tokens + coalesce(in_output_tokens, 0),
         llm_calls = llm_calls + 1,
         cost_usd = case
                      when cost_usd is null and in_cost is null then null
                      else coalesce(cost_usd, 0) + coalesce(in_cost, 0)
                    end
   where id = in_run
     and status = 'running';
end;
$$;

revoke all on function public.increment_local_pi_run_usage(uuid, bigint, bigint, numeric)
  from public, anon, authenticated;
grant execute on function public.increment_local_pi_run_usage(uuid, bigint, bigint, numeric)
  to service_role;

create function public.finish_local_pi_run(
  in_run uuid,
  in_status text,
  in_ended_reason text,
  in_error text
)
returns setof public.local_pi_runs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.local_pi_runs
     set status = in_status,
         ended_reason = in_ended_reason,
         error = in_error,
         ended_at = now()
   where id = in_run
     and status = 'running'
  returning *;
end;
$$;

revoke all on function public.finish_local_pi_run(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_local_pi_run(uuid, text, text, text)
  to service_role;

create function public.track_local_pi_run_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.apply_org_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
  end if;
  return null;
end;
$$;

create trigger track_local_pi_run_spend
after insert or update of org_id, cost_usd or delete on public.local_pi_runs
for each row execute function public.track_local_pi_run_spend();
