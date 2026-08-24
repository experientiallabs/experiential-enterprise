-- The seeded example agent is now presented as the Terminal Agent (it runs
-- against the terminal-tasks starter world model and the onboarding kickoff
-- frames it that way). Rename the generated starter agents without touching
-- agents users renamed, mirroring 20260716183000; internal default-agent
-- slugs and account pointers remain stable.
update public.agents as agent
set
  display_name = 'Terminal Agent',
  updated_at = now()
where agent.display_name = 'Generalist agent'
  and agent.name ~ '^default-agent-[0-9a-f]{16}$';
