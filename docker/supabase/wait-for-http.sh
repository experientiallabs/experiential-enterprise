#!/usr/bin/env sh
set -eu

url="${1:?url is required}"
timeout_seconds="${2:-120}"
deadline=$(( $(date +%s) + timeout_seconds ))

http_ok() {
  if command -v wget >/dev/null 2>&1; then
    wget -qO- "${url}" >/dev/null 2>&1
    return $?
  fi

  if command -v node >/dev/null 2>&1; then
    node -e "fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))" "${url}"
    return $?
  fi

  if command -v python >/dev/null 2>&1; then
    python - "${url}" <<'PY'
import sys
import urllib.request

try:
    with urllib.request.urlopen(sys.argv[1], timeout=2) as response:
        raise SystemExit(0 if 200 <= response.status < 400 else 1)
except Exception:
    raise SystemExit(1)
PY
    return $?
  fi

  echo "No HTTP client found for ${url}" >&2
  return 1
}

while [ "$(date +%s)" -lt "${deadline}" ]; do
  if http_ok; then
    exit 0
  fi
  sleep 2
done

echo "Timed out waiting for ${url}" >&2
exit 1
