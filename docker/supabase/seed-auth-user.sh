#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"
admin_email="${EXPLABS_AUTH_ADMIN_EMAIL:-admin@xplabs.ai}"
admin_password="${EXPLABS_AUTH_ADMIN_PASSWORD:-3XP321!}"
demo_seed_environment="${EXPLABS_DEPLOYMENT_ENVIRONMENT:-local}"
demo_seed_email="${EXPLABS_DEMO_SEED_EMAIL:-demo@experientiallabs.ai}"
demo_seed_password="${EXPLABS_DEMO_SEED_PASSWORD:-DemoShape2026!}"
# Real provider keys (optional) let the demo org seed genuine BYOK provider
# connections. Absent keys mean the connection is simply skipped (no fake key,
# which would hijack routing and fail auth on every live call).
demo_key_openrouter="${OPENROUTER_API_KEY:-}"
demo_key_anthropic="${ANTHROPIC_API_KEY:-}"

/app/docker/supabase/wait-for-postgres.sh "${database_url}" 120

echo "Waiting for Supabase Auth tables..."
for _ in $(seq 1 60); do
  if [ "$(psql "${database_url}" -tAc "select to_regclass('auth.users') is not null;" 2>/dev/null)" = "t" ]; then
    break
  fi
  echo "  auth.users not ready yet..."
  sleep 2
done

if [ "$(psql "${database_url}" -tAc "select to_regclass('auth.users') is not null;")" != "t" ]; then
  echo "error: auth.users was not created by Supabase Auth" >&2
  exit 1
fi

psql "${database_url}" \
  -v ON_ERROR_STOP=1 \
  -v explabs_admin_email="${admin_email}" \
  -v explabs_admin_password="${admin_password}" \
  -v demo_seed_environment="${demo_seed_environment}" \
  -v demo_seed_email="${demo_seed_email}" \
  -v demo_seed_password="${demo_seed_password}" \
  -v demo_key_openrouter="${demo_key_openrouter}" \
  -v demo_key_anthropic="${demo_key_anthropic}" <<'SQL'
select
  set_config('explabs.seed_admin_email', :'explabs_admin_email', false),
  set_config('explabs.seed_admin_password', :'explabs_admin_password', false),
  set_config('explabs.demo_seed_environment', :'demo_seed_environment', false),
  set_config('explabs.demo_seed_email', :'demo_seed_email', false),
  set_config('explabs.demo_seed_password', :'demo_seed_password', false),
  set_config('explabs.demo_provider_key_openrouter', :'demo_key_openrouter', false),
  set_config('explabs.demo_provider_key_anthropic', :'demo_key_anthropic', false)
\g /dev/null
\i /app/supabase/seed.sql
\i /app/supabase/seed-demo.sql
SQL

echo "Seeded Supabase Auth admin user."
echo "Seeded demo-shape org (dev only; environment=${demo_seed_environment})."
