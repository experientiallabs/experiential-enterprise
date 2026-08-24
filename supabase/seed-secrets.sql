-- Optional per-org LLM-provider secret seeding for the demo-examples org.
--
-- Callers pass provider keys as psql -v variables named after the standard
-- provider environment variables (see explabs.secrets.ENV_VAR_BY_SECRET_NAME).
-- Unset or empty variables are skipped with a notice, so this file is safe to
-- \i unconditionally after seed.sql.

\set ON_ERROR_STOP on

\if :{?ANTHROPIC_API_KEY}
\else
  \set ANTHROPIC_API_KEY ''
\endif
\if :{?OPENAI_API_KEY}
\else
  \set OPENAI_API_KEY ''
\endif
\if :{?AWS_ACCESS_KEY_ID}
\else
  \set AWS_ACCESS_KEY_ID ''
\endif
\if :{?AWS_SECRET_ACCESS_KEY}
\else
  \set AWS_SECRET_ACCESS_KEY ''
\endif
\if :{?AWS_REGION}
\else
  \set AWS_REGION ''
\endif
\if :{?AZURE_OPENAI_API_KEY}
\else
  \set AZURE_OPENAI_API_KEY ''
\endif
\if :{?AZURE_OPENAI_ENDPOINT}
\else
  \set AZURE_OPENAI_ENDPOINT ''
\endif

create or replace function pg_temp.seed_org_secret(
  target_org_id uuid,
  secret_name text,
  secret_value text,
  env_name text
)
returns void
language plpgsql
as $$
begin
  if nullif(secret_value, '') is null then
    raise notice 'Skipping org secret % for org % because % is unset.',
      secret_name,
      target_org_id,
      env_name;
    return;
  end if;

  perform public.upsert_org_secret(
    target_org_id,
    secret_name,
    secret_value,
    'seed-script',
    jsonb_build_object('source_env', env_name)
  );
end;
$$;

select pg_temp.seed_org_secret(
  '00000000-0000-0000-0000-000000000002',
  'anthropic_api_key',
  :'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY'
);
select pg_temp.seed_org_secret(
  '00000000-0000-0000-0000-000000000002',
  'openai_api_key',
  :'OPENAI_API_KEY',
  'OPENAI_API_KEY'
);
select pg_temp.seed_org_secret(
  '00000000-0000-0000-0000-000000000002',
  'aws_access_key_id',
  :'AWS_ACCESS_KEY_ID',
  'AWS_ACCESS_KEY_ID'
);
select pg_temp.seed_org_secret(
  '00000000-0000-0000-0000-000000000002',
  'aws_secret_access_key',
  :'AWS_SECRET_ACCESS_KEY',
  'AWS_SECRET_ACCESS_KEY'
);
select pg_temp.seed_org_secret(
  '00000000-0000-0000-0000-000000000002',
  'aws_region',
  :'AWS_REGION',
  'AWS_REGION'
);
select pg_temp.seed_org_secret(
  '00000000-0000-0000-0000-000000000002',
  'azure_openai_api_key',
  :'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY'
);
select pg_temp.seed_org_secret(
  '00000000-0000-0000-0000-000000000002',
  'azure_openai_endpoint',
  :'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_ENDPOINT'
);
