#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  supabase stop --no-backup >/dev/null 2>&1 || true
}

trap cleanup EXIT

cleanup
supabase start
supabase db reset --no-seed

# Export the stack's coordinates BEFORE seeding. The seed must target exactly
# the stack this script just started: with the export after the seed (and a
# hardcoded default port in the seed script), an isolated re-ported stack
# leaked its seed SQL into whichever OTHER stack owned the default port.
# No hardcoded port fallbacks — a stack that cannot report its own
# coordinates is a failure, not something to paper over.
status_file="$(mktemp)"
supabase status -o env > "${status_file}"
set -a
source "${status_file}"
set +a
rm -f "${status_file}"

export SUPABASE_URL="${SUPABASE_URL:-${API_URL:?supabase status reported no API_URL}}"
export SUPABASE_DB_URL="${SUPABASE_DB_URL:-${DB_URL:?supabase status reported no DB_URL}}"
export SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-${ANON_KEY:-${PUBLISHABLE_KEY:?supabase status reported no anon/publishable key}}}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${SERVICE_ROLE_KEY:-${SECRET_KEY:?supabase status reported no service-role/secret key}}}"

"${repo_root}/scripts/seed_supabase_local.sh"

supabase test db

# Run integration-marked pytest suites only when they exist: pytest exits 5
# when a marker selects zero tests, which would fail this script for no reason.
if grep -rq "pytest.mark.integration" "${repo_root}/explabs"; then
  UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/.uv-cache}" uv run pytest -m integration
else
  echo "No integration-marked pytest suites found under explabs/; skipping pytest."
fi
