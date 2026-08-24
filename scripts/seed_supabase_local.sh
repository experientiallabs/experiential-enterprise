#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_local_env_file="${repo_root}/.env.local"

if [ -n "${EXPLABS_STACK_LOCAL_ENV_FILE:-}" ]; then
  local_env_file="${EXPLABS_STACK_LOCAL_ENV_FILE}"
else
  local_env_file="${repo_local_env_file}"
fi

# A caller's exported SUPABASE_DB_URL (e.g. the integration runner naming the
# stack it just started) outranks the local env file: the dotfile is developer
# ambience, not an override of a caller that named its target — a stale
# .env.local entry must not redirect the seed to a different database.
caller_db_url="${SUPABASE_DB_URL:-}"

set -a
if [ -f "${local_env_file}" ]; then
  source "${local_env_file}"
  echo "Loaded ${local_env_file}"
fi
set +a

if [ -n "${caller_db_url}" ]; then
  SUPABASE_DB_URL="${caller_db_url}"
fi

# Resolve THIS checkout's running Supabase CLI stack instead of assuming the
# default port. The old hardcoded default-port fallback silently seeded
# whichever stack owned that port — with an isolated (re-ported) stack that
# was another session's database. Precedence: caller env, then the local env
# file, then the CLI's report for this workdir's supabase/config.toml; no
# running stack is a loud failure, never a cross-stack write.
if [ -z "${SUPABASE_DB_URL:-}" ]; then
  # `|| true` so a stopped stack reaches the explicit error below instead of
  # dying silently in the substitution under set -e -o pipefail.
  SUPABASE_DB_URL="$(supabase status -o env 2>/dev/null | sed -n 's/^DB_URL=//p' | tr -d '"' || true)"
fi
if [ -z "${SUPABASE_DB_URL}" ]; then
  echo "seed_supabase_local: SUPABASE_DB_URL is unset and 'supabase status' reported no running stack for this checkout." >&2
  echo "Start it with 'supabase start', or export SUPABASE_DB_URL to seed a specific database." >&2
  exit 1
fi
database_url="${SUPABASE_DB_URL}"
admin_email="${EXPLABS_AUTH_ADMIN_EMAIL:-admin@xplabs.ai}"
admin_password="${EXPLABS_AUTH_ADMIN_PASSWORD:-3XP321!}"

# Provider keys are optional; seed-secrets.sql and seed-gateway-catalog.sql
# skip any that are empty.
legacy_serving_base_url="${EXPLABS_GATEWAY_LEGACY_SERVING_BASE_URL:-}"

# Demo-shape seed (dev only). Populates a signed-in-ready demo org for local UI
# evaluation. The environment gate refuses to run in production.
demo_seed_environment="${EXPLABS_DEPLOYMENT_ENVIRONMENT:-local}"
demo_seed_email="${EXPLABS_DEMO_SEED_EMAIL:-demo@experientiallabs.ai}"
demo_seed_password="${EXPLABS_DEMO_SEED_PASSWORD:-DemoShape2026!}"

psql "${database_url}" \
  -v ON_ERROR_STOP=1 \
  -v explabs_admin_email="${admin_email}" \
  -v explabs_admin_password="${admin_password}" \
  -v demo_seed_environment="${demo_seed_environment}" \
  -v demo_seed_email="${demo_seed_email}" \
  -v demo_seed_password="${demo_seed_password}" \
  -v ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  -v OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  -v OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
  -v GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
  -v FIREWORKS_API_KEY="${FIREWORKS_API_KEY:-}" \
  -v AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}" \
  -v AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}" \
  -v AWS_REGION="${AWS_REGION:-}" \
  -v AZURE_OPENAI_API_KEY="${AZURE_OPENAI_API_KEY:-}" \
  -v AZURE_OPENAI_ENDPOINT="${AZURE_OPENAI_ENDPOINT:-}" \
  -v EXPLABS_GATEWAY_LEGACY_SERVING_BASE_URL="${legacy_serving_base_url}" <<SQL
select
  set_config('explabs.seed_admin_email', :'explabs_admin_email', false),
  set_config('explabs.seed_admin_password', :'explabs_admin_password', false),
  set_config('explabs.demo_seed_environment', :'demo_seed_environment', false),
  set_config('explabs.demo_seed_email', :'demo_seed_email', false),
  set_config('explabs.demo_seed_password', :'demo_seed_password', false),
  set_config('explabs.demo_provider_key_openrouter', :'OPENROUTER_API_KEY', false),
  set_config('explabs.demo_provider_key_anthropic', :'ANTHROPIC_API_KEY', false)
\g /dev/null
\i '${repo_root}/supabase/seed.sql'
\i '${repo_root}/supabase/seed-secrets.sql'
\i '${repo_root}/supabase/seed-gateway-catalog.sql'
\i '${repo_root}/supabase/seed-demo-account.sql'
\i '${repo_root}/supabase/seed-demo.sql'
SQL

# Benchmark scores and release links ride the committed JSON store, not the
# SQL seed.
(cd "${repo_root}" && SUPABASE_DB_URL="${database_url}" \
  uv run python scripts/apply_model_benchmarks.py)
