#!/usr/bin/env sh
set -eu

database_url="${1:?database url is required}"
timeout_seconds="${2:-120}"
deadline=$(( $(date +%s) + timeout_seconds ))

while [ "$(date +%s)" -lt "${deadline}" ]; do
  if pg_isready -d "${database_url}" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done

echo "Timed out waiting for Postgres" >&2
exit 1

