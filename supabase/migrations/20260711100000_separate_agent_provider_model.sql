-- Keep provider routing separate from canonical agent-model identity.

-- World-model rows already have separate provider/model columns. Normalize
-- legacy provider runtime ids so the model column carries the same canonical
-- identity used by direct APIs and the agent catalog.
update public.world_models
set serve_model = case serve_model
  when 'us.anthropic.claude-opus-4-8' then 'claude-opus-4-8'
  when 'us.anthropic.claude-opus-4-7' then 'claude-opus-4-7'
  when 'us.anthropic.claude-sonnet-4-6' then 'claude-sonnet-4-6'
  when 'us.anthropic.claude-haiku-4-5-20251001-v1:0' then 'claude-haiku-4-5'
  when 'zai.glm-5' then 'glm-5'
  when 'qwen.qwen3-vl-235b-a22b' then 'qwen3-vl-235b-a22b'
  when 'openai.gpt-oss-120b-1:0' then 'gpt-oss-120b'
  else serve_model
end;

update public.wm_catalog_entries
set serve_model = case serve_model
  when 'us.anthropic.claude-opus-4-8' then 'claude-opus-4-8'
  when 'us.anthropic.claude-opus-4-7' then 'claude-opus-4-7'
  when 'us.anthropic.claude-sonnet-4-6' then 'claude-sonnet-4-6'
  when 'us.anthropic.claude-haiku-4-5-20251001-v1:0' then 'claude-haiku-4-5'
  when 'zai.glm-5' then 'glm-5'
  when 'qwen.qwen3-vl-235b-a22b' then 'qwen3-vl-235b-a22b'
  when 'openai.gpt-oss-120b-1:0' then 'gpt-oss-120b'
  else serve_model
end;

alter table public.agents
  add column agent_provider text;

alter table public.wm_rollouts
  add column agent_provider text;

alter table public.agent_sessions
  add column agent_provider text;

update public.agents
set agent_provider = case
  when agent_model like 'azure-%' then 'azure'
  else 'bedrock'
end;

update public.wm_rollouts
set agent_provider = case
  when agent_model like 'azure-%' then 'azure'
  else 'bedrock'
end;

update public.agent_sessions
set agent_provider = case
  when agent_model like 'azure-%' then 'azure'
  else 'bedrock'
end;

update public.agents
set agent_model = case agent_model
  when 'azure-deepseek' then 'deepseek-v4-pro'
  when 'azure-kimi' then 'kimi-k2.6'
  when 'azure-gpt-5-4-mini' then 'gpt-5.4-mini'
  when 'azure-gpt-5-5' then 'gpt-5.5'
  when 'bedrock-qwen3-vl-235b' then 'qwen3-vl-235b-a22b'
  when 'bedrock-glm-5' then 'glm-5'
  when 'bedrock-gpt-oss-120b' then 'gpt-oss-120b'
  when 'bedrock-claude-opus-4-8' then 'claude-opus-4-8'
  when 'bedrock-claude-sonnet-4-6' then 'claude-sonnet-4-6'
  when 'bedrock-claude-haiku-4-5' then 'claude-haiku-4-5'
  when 'us.anthropic.claude-opus-4-8' then 'claude-opus-4-8'
  when 'us.anthropic.claude-sonnet-4-6' then 'claude-sonnet-4-6'
  when 'us.anthropic.claude-haiku-4-5-20251001-v1:0' then 'claude-haiku-4-5'
  -- Leave unknown legacy ids untouched so the canonical check below rejects
  -- them instead of silently creating a provider/model pair the catalog cannot resolve.
  else agent_model
end;

update public.wm_rollouts
set agent_model = case agent_model
  when 'azure-deepseek' then 'deepseek-v4-pro'
  when 'azure-kimi' then 'kimi-k2.6'
  when 'azure-gpt-5-4-mini' then 'gpt-5.4-mini'
  when 'azure-gpt-5-5' then 'gpt-5.5'
  when 'bedrock-qwen3-vl-235b' then 'qwen3-vl-235b-a22b'
  when 'bedrock-glm-5' then 'glm-5'
  when 'bedrock-gpt-oss-120b' then 'gpt-oss-120b'
  when 'bedrock-claude-opus-4-8' then 'claude-opus-4-8'
  when 'bedrock-claude-sonnet-4-6' then 'claude-sonnet-4-6'
  when 'bedrock-claude-haiku-4-5' then 'claude-haiku-4-5'
  when 'us.anthropic.claude-opus-4-8' then 'claude-opus-4-8'
  when 'us.anthropic.claude-sonnet-4-6' then 'claude-sonnet-4-6'
  when 'us.anthropic.claude-haiku-4-5-20251001-v1:0' then 'claude-haiku-4-5'
  else agent_model
end;

update public.agent_sessions
set agent_model = case agent_model
  when 'azure-deepseek' then 'deepseek-v4-pro'
  when 'azure-kimi' then 'kimi-k2.6'
  when 'azure-gpt-5-4-mini' then 'gpt-5.4-mini'
  when 'azure-gpt-5-5' then 'gpt-5.5'
  when 'bedrock-qwen3-vl-235b' then 'qwen3-vl-235b-a22b'
  when 'bedrock-glm-5' then 'glm-5'
  when 'bedrock-gpt-oss-120b' then 'gpt-oss-120b'
  when 'bedrock-claude-opus-4-8' then 'claude-opus-4-8'
  when 'bedrock-claude-sonnet-4-6' then 'claude-sonnet-4-6'
  when 'bedrock-claude-haiku-4-5' then 'claude-haiku-4-5'
  when 'us.anthropic.claude-opus-4-8' then 'claude-opus-4-8'
  when 'us.anthropic.claude-sonnet-4-6' then 'claude-sonnet-4-6'
  when 'us.anthropic.claude-haiku-4-5-20251001-v1:0' then 'claude-haiku-4-5'
  else agent_model
end;

alter table public.agents
  alter column agent_provider set not null,
  add constraint agents_agent_provider_check
    check (agent_provider in ('anthropic', 'azure', 'bedrock', 'openai', 'openai_responses')),
  add constraint agents_agent_model_canonical_check
    check (agent_model !~ '^(azure|bedrock)[-/]');

alter table public.wm_rollouts
  alter column agent_provider set not null,
  add constraint wm_rollouts_agent_provider_check
    check (agent_provider in ('anthropic', 'azure', 'bedrock', 'openai', 'openai_responses')),
  add constraint wm_rollouts_agent_model_canonical_check
    check (agent_model !~ '^(azure|bedrock)[-/]');

alter table public.agent_sessions
  alter column agent_provider set not null,
  add constraint agent_sessions_agent_provider_check
    check (agent_provider in ('anthropic', 'azure', 'bedrock', 'openai', 'openai_responses')),
  add constraint agent_sessions_agent_model_canonical_check
    check (agent_model !~ '^(azure|bedrock)[-/]');

drop function public.admit_agent_session(
  uuid, uuid, uuid, int, text, boolean, int, int, int, int
);

create function public.admit_agent_session(
  in_agent uuid,
  in_org uuid,
  in_created_by uuid,
  in_harness_version int,
  in_agent_provider text,
  in_agent_model text,
  in_budget_exempt boolean,
  in_idle_timeout_s int,
  in_max_duration_s int,
  in_org_cap int,
  in_global_cap int
)
returns setof public.agent_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.agent_sessions;
begin
  perform pg_advisory_xact_lock(hashtext('agent_session_admission'));

  if exists (
    select 1 from public.agent_sessions
     where agent_id = in_agent
       and status in ('starting', 'running', 'ending')
  ) then
    raise exception 'agent_active' using errcode = 'P0001';
  end if;

  if in_org_cap > 0 and (
    select count(*) from public.agent_sessions
     where org_id = in_org
       and status in ('starting', 'running', 'ending')
  ) >= in_org_cap then
    raise exception 'org_full' using errcode = 'P0001';
  end if;

  if in_global_cap > 0 and (
    select count(*) from public.agent_sessions
     where status in ('starting', 'running', 'ending')
  ) >= in_global_cap then
    raise exception 'global_full' using errcode = 'P0001';
  end if;

  insert into public.agent_sessions (
    agent_id, org_id, created_by, harness_version, agent_provider, agent_model,
    budget_exempt, idle_timeout_s, max_duration_s
  ) values (
    in_agent, in_org, in_created_by, in_harness_version, in_agent_provider, in_agent_model,
    in_budget_exempt, in_idle_timeout_s, in_max_duration_s
  )
  returning * into v_row;
  return next v_row;
end;
$$;

revoke all on function public.admit_agent_session(
  uuid, uuid, uuid, int, text, text, boolean, int, int, int, int
) from public, anon, authenticated;
grant execute on function public.admit_agent_session(
  uuid, uuid, uuid, int, text, text, boolean, int, int, int, int
) to service_role;
