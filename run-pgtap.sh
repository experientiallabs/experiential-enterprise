#!/usr/bin/env bash
# Run the repo's pgTAP suites against a live database (preview branch pooler).
# Usage: DB_URL=postgres://... ./run-pgtap.sh
set -euo pipefail
: "${DB_URL:?DB_URL must be set}"

cd "$(dirname "$0")"
fail=0
for f in supabase/tests/database/*.test.sql; do
  echo "=== ${f}"
  out="$(psql "${DB_URL}" -v ON_ERROR_STOP=1 -X -q -f "${f}" 2>&1)" || { echo "${out}"; echo "PSQL_ERROR in ${f}"; fail=1; continue; }
  echo "${out}"
  if echo "${out}" | grep -E "^not ok" >/dev/null; then
    echo "FAILURES in ${f}"
    fail=1
  fi
done
exit "${fail}"
