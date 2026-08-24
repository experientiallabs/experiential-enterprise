#!/usr/bin/env bash
# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# Gateway end-to-end suite (plans/gw-platform-integration.md, packet int-P9):
# ten scenarios against the compose stack pr_auto_smoke.sh already started,
# with REAL gateway worker processes over the stack's Postgres. Runs on the
# host (the api image ships without dev dependencies), so the caller needs uv
# and a synced environment; the workflow step provides both.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

env_file="${repo_root}/docker/.env"
if [ -f "${env_file}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

# The stack's Postgres, on whatever host port this checkout's .env chose.
export SUPABASE_DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:${POSTGRES_PASSWORD:-postgres}@127.0.0.1:${EXPLABS_DB_HOST_PORT:-55422}/postgres}"

UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/.uv-cache}" uv run pytest \
  explabs/gateway/e2e_test.py -m integration -x -q
