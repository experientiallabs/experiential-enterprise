#!/usr/bin/env sh
set -eu

/app/docker/supabase/wait-for-http.sh "${EXPLABS_BACKEND_URL}/health" 120
exec pnpm --dir apps/web start -H 0.0.0.0 -p "${PORT:-3000}"

