-- Agent scenario suites are durable evaluation inputs independent of an
-- optimizer attempt. Account provisioning can therefore attach a real,
-- zero-spend starter suite to the Default agent without manufacturing run
-- history. A suite is keyed by (agent, world model), so switching models
-- hides mismatched scenarios while preserving them if the user switches back.

create table public.agent_scenario_suites (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  world_model_id uuid not null references public.world_models(id) on delete cascade,
  source text not null check (source in ('catalog')),
  -- Raw wmh TaskSpec payloads ({task_id, instruction, gold}).
  tasks jsonb not null check (jsonb_typeof(tasks) = 'array'),
  -- The corresponding explabs.engine.task_map.TaskMap payload.
  task_map jsonb not null check (jsonb_typeof(task_map) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, world_model_id)
);

create index agent_scenario_suites_world_model_idx
  on public.agent_scenario_suites (world_model_id);

create trigger agent_scenario_suites_set_updated_at
before update on public.agent_scenario_suites
for each row execute function public.set_updated_at();

grant select on public.agent_scenario_suites to authenticated;
grant select, insert, update, delete on public.agent_scenario_suites to service_role;

alter table public.agent_scenario_suites enable row level security;

create policy agent_scenario_suites_select_member
  on public.agent_scenario_suites
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.agents agents
      where agents.id = agent_scenario_suites.agent_id
        and agents.org_id in (select public.member_org_ids())
    )
  );

-- Runs and reports need to retain which world model they evaluated once the
-- agent's selector changes. Existing rows inherit the agent's current model;
-- all future writes snapshot it at queue time.
alter table public.agent_opt_runs
  add column world_model_id uuid;

update public.agent_opt_runs runs
set world_model_id = agents.world_model_id
from public.agents agents
where agents.id = runs.agent_id;

alter table public.agent_opt_runs
  alter column world_model_id set not null;

create index agent_opt_runs_agent_world_model_created_idx
  on public.agent_opt_runs (agent_id, world_model_id, created_at desc);

alter table public.agent_cost_reports
  add column world_model_id uuid;

update public.agent_cost_reports reports
set world_model_id = agents.world_model_id
from public.agents agents
where agents.id = reports.agent_id;

alter table public.agent_cost_reports
  alter column world_model_id set not null;

create index agent_cost_reports_agent_world_model_created_idx
  on public.agent_cost_reports (agent_id, world_model_id, created_at desc);

-- Service callers write the snapshot explicitly. This trigger is the DB
-- backstop for SQL fixtures and direct administrative inserts, matching the
-- existing org-id denormalization convention.
create function public.fill_agent_work_world_model()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.world_model_id is null then
    select agents.world_model_id
    into new.world_model_id
    from public.agents agents
    where agents.id = new.agent_id;
  end if;
  return new;
end;
$$;

create trigger fill_opt_run_world_model
before insert on public.agent_opt_runs
for each row execute function public.fill_agent_work_world_model();

create trigger fill_cost_report_world_model
before insert on public.agent_cost_reports
for each row execute function public.fill_agent_work_world_model();
