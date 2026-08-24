-- Rename the generated starter agent without touching agents users renamed.
-- Internal default-agent slugs and account pointers remain stable.
update public.agents as agent
set
  display_name = 'Generalist agent',
  updated_at = now()
where agent.display_name = 'Default agent'
  and agent.name ~ '^default-agent-[0-9a-f]{16}$';
