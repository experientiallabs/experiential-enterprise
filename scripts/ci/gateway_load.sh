#!/usr/bin/env bash
# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# Gateway load/latency smoke: runs explabs/gateway/load_test.py against the
# compose stack pr_auto_smoke.sh already started, driving a host-side loopback
# provider through BOTH serving targets — the public /v1 edge and the worker's
# published host port — so edge overhead and worker-native latency land in
# separate reports. Runs on the host (the api image ships without dev
# dependencies), so the caller needs uv and a synced environment; the workflow
# step provides both.
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

# The stack's Postgres and serving targets, on whatever host ports this
# checkout's .env chose.
export SUPABASE_DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:${POSTGRES_PASSWORD:-postgres}@127.0.0.1:${EXPLABS_DB_HOST_PORT:-55422}/postgres}"
export EXPLABS_LOAD_EDGE_URL="${EXPLABS_LOAD_EDGE_URL:-http://127.0.0.1:${EXPLABS_API_HOST_PORT:-18080}}"
export EXPLABS_LOAD_WORKER_URL="${EXPLABS_LOAD_WORKER_URL:-http://127.0.0.1:${EXPLABS_GATEWAY_WORKER_HOST_PORT:-18081}}"

# Fresh report per run: the test appends to the file, so a stale one would mix
# runs in the published artifact.
export EXPLABS_LOAD_REPORT_PATH="${EXPLABS_LOAD_REPORT_PATH:-/tmp/gateway-load-report.json}"
rm -f "${EXPLABS_LOAD_REPORT_PATH}"

UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/.uv-cache}" uv run pytest \
  explabs/gateway/load_test.py -m integration -q -s

echo "== gateway load report (${EXPLABS_LOAD_REPORT_PATH}) =="
cat "${EXPLABS_LOAD_REPORT_PATH}"
