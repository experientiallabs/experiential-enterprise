#!/usr/bin/env sh
set -eu

if [ "${EXPLABS_GATEWAY_WORKER_ONLY:-}" = "1" ]; then
  exec /app/.venv/bin/explabs-gateway-worker --host 0.0.0.0 --port "${PORT:-8080}"
fi

exec /app/.venv/bin/explabs-api --host 0.0.0.0 --port "${PORT:-8080}"
