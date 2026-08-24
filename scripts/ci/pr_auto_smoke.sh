#!/usr/bin/env bash
# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# Automatic PR smoke check: bring up the local Docker stack from a clean checkout
# and run the Docker stack smoke. This automatic baseline needs no cloud
# credentials.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

scripts/integration_stack.sh reset

# Reclaim Docker build cache once images exist: the CI job uses prune-only disk
# reclaim, so this buildx-cache space is part of the runner's remaining margin.
# Running containers are unaffected.
docker builder prune --all --force >/dev/null 2>&1 || true

# Derive the API/web URLs from the same host ports the stack was started with, so a
# custom-port stack (configured via docker/.env) is checked on the right ports.
# Explicit EXPLABS_API_URL / EXPLABS_WEB_URL still take precedence.
env_file="${repo_root}/docker/.env"
if [ -f "${env_file}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi
if [ -z "${EXPLABS_API_KEY:-}" ]; then
  EXPLABS_API_KEY="local-explabs-api-key"
  export EXPLABS_API_KEY
fi
api_port="${EXPLABS_API_HOST_PORT:-18080}"
web_port="${EXPLABS_WEB_HOST_PORT:-3300}"
api_url="${EXPLABS_API_URL:-http://127.0.0.1:${api_port}}"
# Referenced only by the Playwright re-enable instructions below.
# shellcheck disable=SC2034
web_url="${EXPLABS_WEB_URL:-http://127.0.0.1:${web_port}}"

# Host-side probes: health and authenticated organization access.
# shellcheck source=scripts/lib/smoke.sh
. "${repo_root}/scripts/lib/smoke.sh"
smoke_backend "${api_url}" "${EXPLABS_API_KEY}" --require-seed

# UI (Playwright) tests disabled — the API smoke is sufficient for this gate.
# To re-enable, add Node/pnpm/Playwright to the runner and then run
# EXPLABS_WEB_URL="${web_url}" pnpm --dir apps/web e2e
echo "Skipping Playwright UI tests (disabled in CI)"
