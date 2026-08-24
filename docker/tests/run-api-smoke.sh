#!/usr/bin/env sh
set -eu

api_url="${API_URL:-http://api:8080}"
# The seeded platform admin from supabase/seed.sql; /api routes require an
# acting user alongside the deployment bearer key.
actor_id="${SMOKE_ACTOR_ID:-00000000-0000-0000-0000-000000000099}"
wget -qO- "${api_url}/health" | grep '"ok":true'
wget -qO- --header "Authorization: Bearer ${EXPLABS_API_KEY:?EXPLABS_API_KEY must be set}" \
  --header "X-Explabs-Actor-Id: ${actor_id}" \
  "${api_url}/api/orgs" | grep '"demo-examples"'
