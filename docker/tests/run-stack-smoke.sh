#!/usr/bin/env sh
set -eu

/app/docker/supabase/wait-for-http.sh "${API_URL:-http://api:8080}/health" 120
/app/docker/supabase/wait-for-http.sh "${GATEWAY_WORKER_URL:-http://gateway-worker:8080}/health/ready" 120
/app/docker/supabase/wait-for-http.sh "${AUTH_URL:-http://supabase-auth:9999}/health" 120
/app/docker/supabase/wait-for-http.sh "${WEB_URL:-http://web:3000}/api/health" 120

/app/docker/tests/run-db-smoke.sh
/app/docker/tests/run-api-smoke.sh
/app/docker/tests/run-web-smoke.sh

echo "stack smoke passed"
