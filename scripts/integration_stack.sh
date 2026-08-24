#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/docker/compose.yml"
env_file="${repo_root}/docker/.env"
example_env_file="${repo_root}/docker/.env.example"
repo_local_env_file="${repo_root}/.env.local"

if [ -n "${EXPLABS_STACK_LOCAL_ENV_FILE:-}" ]; then
  local_env_file="${EXPLABS_STACK_LOCAL_ENV_FILE}"
else
  local_env_file="${repo_local_env_file}"
fi

if [ ! -f "${env_file}" ]; then
  cp "${example_env_file}" "${env_file}"
  echo "Created ${env_file} from docker/.env.example"
fi

set -a
if [ -f "${local_env_file}" ]; then
  source "${local_env_file}"
  echo "Loaded ${local_env_file}"
fi
source "${env_file}"
set +a

if [ -z "${EXPLABS_STACK_PROJECT_NAME:-}" ]; then
  stack_suffix="$(printf '%s' "${repo_root}" | shasum | awk '{print substr($1, 1, 8)}')"
  EXPLABS_STACK_PROJECT_NAME="explabs-local-${stack_suffix}"
  export EXPLABS_STACK_PROJECT_NAME
fi

if [ -z "${EXPLABS_API_KEY:-}" ]; then
  EXPLABS_API_KEY="local-explabs-api-key"
  export EXPLABS_API_KEY
fi
if [ -z "${EXPLABS_PROJECT_SERVING_DEPLOYMENT_KEY:-}" ]; then
  EXPLABS_PROJECT_SERVING_DEPLOYMENT_KEY="local-explabs-project-serving-key"
  export EXPLABS_PROJECT_SERVING_DEPLOYMENT_KEY
fi
if [ -z "${EXPLABS_GATEWAY_WORKER_KEY:-}" ]; then
  EXPLABS_GATEWAY_WORKER_KEY="local-explabs-gateway-worker-key"
  export EXPLABS_GATEWAY_WORKER_KEY
fi
if [ -z "${EXPLABS_PLATFORM_PROVIDER_REVISION:-}" ]; then
  EXPLABS_PLATFORM_PROVIDER_REVISION="local-provider-v1"
  export EXPLABS_PLATFORM_PROVIDER_REVISION
fi
if [ "${EXPLABS_API_KEY}" = "${EXPLABS_PROJECT_SERVING_DEPLOYMENT_KEY}" ]; then
  echo "Public and Project-serving deployment keys must be distinct." >&2
  exit 1
fi
if [ "${EXPLABS_GATEWAY_WORKER_KEY}" = "${EXPLABS_API_KEY}" ] \
  || [ "${EXPLABS_GATEWAY_WORKER_KEY}" = "${EXPLABS_PROJECT_SERVING_DEPLOYMENT_KEY}" ]; then
  echo "The gateway-worker drain key must be distinct from every other deployment key." >&2
  exit 1
fi
LC_ALL=C
export LC_ALL
if [[ ! "${EXPLABS_PLATFORM_PROVIDER_REVISION}" =~ ^[[:print:]]{1,128}$ ]]; then
  echo "EXPLABS_PLATFORM_PROVIDER_REVISION must be 1-128 printable ASCII characters." >&2
  exit 1
fi

compose() {
  docker compose --project-name "${EXPLABS_STACK_PROJECT_NAME}" --env-file "${env_file}" -f "${compose_file}" "$@"
}

retry_compose() {
  local description="$1"
  shift

  local attempts="${EXPLABS_DOCKER_ATTEMPTS:-3}"
  local delay_seconds="${EXPLABS_DOCKER_RETRY_DELAY_SECONDS:-20}"
  local attempt=1

  while true; do
    if "$@"; then
      return 0
    fi

    if [ "${attempt}" -ge "${attempts}" ]; then
      echo "${description} failed after ${attempts} attempts" >&2
      return 1
    fi

    echo "${description} failed on attempt ${attempt}/${attempts}; retrying in ${delay_seconds}s" >&2
    sleep "${delay_seconds}"
    attempt=$((attempt + 1))
  done
}

pull_stack_images() {
  # mailpit and mail-templates ride the same retried pre-pull as the rest of
  # the infra images (both are pinned Docker Hub tags outside the mirror).
  retry_compose "Docker image pull" compose pull supabase-db supabase-migrate \
    supabase-rest supabase-auth supabase-auth-seed supabase-storage \
    supabase-kong mailpit mail-templates stack-smoke
}

build_current_images() {
  if [ "${EXPLABS_STACK_SKIP_BUILD:-}" = "1" ]; then
    return
  fi

  # The api and gateway-worker services share one API image tag. Building
  # them through `compose up --build` lets the classic builder race several
  # writers onto that tag. Build each distinct current image once, then start
  # every service with builds disabled.
  retry_compose "Current application image build" \
    compose build api web
}

dump_start_failure_logs() {
  echo "Docker stack start failed; current service state follows." >&2
  compose ps --all >&2 || true
  compose logs --no-color --tail="${EXPLABS_STACK_LOG_TAIL:-300}" \
    supabase-db supabase-migrate supabase-rest supabase-auth \
    supabase-auth-seed mailpit mail-templates supabase-storage \
    supabase-kong api gateway-worker web >&2 || true
}

start_stack() {
  pull_stack_images
  build_current_images

  local attempts="${EXPLABS_DOCKER_ATTEMPTS:-3}"
  local delay_seconds="${EXPLABS_DOCKER_RETRY_DELAY_SECONDS:-20}"
  local attempt=1

  # Whether any of this project's volumes already existed before this start. A
  # retry may only wipe volumes when they were created fresh this run: on a
  # pre-existing volume the db holds user-created rows, and `down -v` would
  # destroy them (a transient api/web failure must never wipe a customer's
  # world models). Detection goes by compose's project label rather than a
  # reconstructed "<project>_<key>" name so a renamed volume key in compose.yml
  # cannot silently defeat the guard — any pre-existing project volume fails
  # the check SAFE (toward preserving data).
  local db_volume_preexisted="no"
  if [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=${EXPLABS_STACK_PROJECT_NAME}" | head -1)" ]; then
    db_volume_preexisted="yes"
  fi

  # Images are either built once above or supplied out of band by CI. Never let
  # Compose rebuild shared tags while it is also starting the stack.
  local up_args=(up --remove-orphans -d --no-build)

  while true; do
    # mailpit (SMTP catcher) and mail-templates (serves GoTrue's template
    # URLs) must start with the stack: GoTrue's mailer points at both
    # (docker/compose.yml), and without them every emailed sign-in code
    # fails to send. Both are long-running services with no depends_on
    # edges, so they simply join the up list.
    if compose "${up_args[@]}" supabase-db \
      supabase-migrate supabase-rest supabase-auth supabase-auth-seed \
      mailpit mail-templates \
      supabase-storage supabase-kong api gateway-worker web; then
      return 0
    fi

    dump_start_failure_logs

    if [ "${attempt}" -ge "${attempts}" ]; then
      echo "Docker stack start failed after ${attempts} attempts" >&2
      return 1
    fi

    if [ "${db_volume_preexisted}" = "yes" ]; then
      # The db volume predates this start, so it may hold user data. Clean only
      # containers and keep the volume: migrations are idempotent, so a re-run
      # against the existing schema is a no-op, and no data is lost to a retry.
      echo "Docker stack start failed on attempt ${attempt}/${attempts}; cleaning containers (preserving the existing db volume) and retrying in ${delay_seconds}s" >&2
      compose down --remove-orphans || true
    else
      # Fresh volume this run: a partially applied migration can poison it, so a
      # container-only cleanup would make every retry fail identically. Wiping the
      # just-created volume is safe because it holds no user data yet.
      echo "Docker stack start failed on attempt ${attempt}/${attempts}; removing the freshly created volumes and retrying in ${delay_seconds}s" >&2
      compose down -v --remove-orphans || true
    fi
    sleep "${delay_seconds}"
    attempt=$((attempt + 1))
  done
}

run_smoke() {
  compose --profile smoke run --rm --no-deps stack-smoke
  # The gateway-worker acceptance is provider-free: it hosts its own loopback
  # OpenAI-compatible provider, so it runs on every stack without fixture env.
  compose --profile smoke run --rm --no-deps gateway-worker-acceptance
  # Live-traffic proof for the Insights suggestions pipeline, same loopback
  # pattern: real streams settle real ledger rows, and the suggestions engine
  # must emit the caching/compression/cheaper-model advice they imply.
  compose --profile smoke run --rm --no-deps insights-suggestions-acceptance
}

usage() {
  cat <<'EOF'
Usage: ./scripts/integration_stack.sh <command>

Commands:
  up       Build and start the local integration stack.
  smoke    Run stack smoke checks against the running stack.
  logs     Follow stack logs.
  dump-logs
           Print recent stack logs without following.
  status   Show compose service status.
  down     Stop the stack.
  reset    Stop, remove volumes, rebuild, start, and smoke-test the stack.
  config   Render resolved compose config.
EOF
}

command="${1:-}"

case "${command}" in
  up)
    start_stack
    echo "Web: http://localhost:${EXPLABS_WEB_HOST_PORT:-3300}"
    echo "API: http://localhost:${EXPLABS_API_HOST_PORT:-18080}"
    ;;
  smoke)
    run_smoke
    ;;
  logs)
    compose logs -f
    ;;
  dump-logs)
    compose logs --no-color --tail="${EXPLABS_STACK_LOG_TAIL:-300}"
    ;;
  status)
    compose ps
    ;;
  down)
    compose down --remove-orphans
    ;;
  reset)
    compose down -v --remove-orphans
    start_stack
    run_smoke
    echo "Web: http://localhost:${EXPLABS_WEB_HOST_PORT:-3300}"
    echo "API: http://localhost:${EXPLABS_API_HOST_PORT:-18080}"
    ;;
  config)
    compose config
    ;;
  *)
    usage
    exit 2
    ;;
esac
