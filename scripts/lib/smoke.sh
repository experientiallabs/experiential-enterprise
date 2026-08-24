# shellcheck shell=bash
# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# Shared backend smoke probes, sourced by the stack smoke drivers:
#   smoke_backend       health + authenticated /api/orgs (+ optional seed/web checks)
#   smoke_login         Supabase password login returns an access token (login shape)
#   smoke_gateway_edge_surface proves the transparent /v1 proxy without spend
# Factor the probes here so the health/auth/serving contract is defined once.
#
# Not executed directly; requires curl and python3.

# /api/* routes require an acting user alongside the bearer key
# (X-Explabs-Actor-Id); smokes act as the seeded platform admin, whose stable
# uuid comes from supabase/seed.sql.
SMOKE_ACTOR_ID="${SMOKE_ACTOR_ID:-00000000-0000-0000-0000-000000000099}"

# Smoke-check a backend. Usage:
#   smoke_backend BASE_URL API_KEY [--require-seed] [--web WEB_URL]
#   --require-seed  also assert at least one seeded org is present (preview).
#   --web WEB_URL   also check the webapp is reachable (reachable / protected / broken).
smoke_backend() {
  local base="${1%/}" api_key="$2"
  shift 2
  local require_seed="false" web_url="" orgs_json status
  while [ $# -gt 0 ]; do
    case "$1" in
      --require-seed)
        require_seed="true"
        shift
        ;;
      --web)
        web_url="${2:-}"
        shift 2
        ;;
      *)
        echo "smoke_backend: unknown argument '$1'" >&2
        return 2
        ;;
    esac
  done

  # Health is unauthenticated; /api/* requires the bearer key plus an actor.
  curl -fsS "${base}/health" >/dev/null
  echo "API health: ok"

  orgs_json="$(mktemp)"
  curl -fsS "${base}/api/orgs" \
    -H "Authorization: Bearer ${api_key}" \
    -H "X-Explabs-Actor-Id: ${SMOKE_ACTOR_ID}" \
    -o "${orgs_json}"
  REQUIRE_SEED="${require_seed}" python3 - "${orgs_json}" <<'PY'
import json
import os
import sys
from pathlib import Path

orgs = json.loads(Path(sys.argv[1]).read_text())
if os.environ.get("REQUIRE_SEED") == "true":
    assert isinstance(orgs, list) and orgs, "expected at least one org"
    print(f"API serves {len(orgs)} seeded org(s)")
else:
    assert isinstance(orgs, list), (
        f"expected a JSON list of orgs, got {type(orgs).__name__}"
    )
    print(f"API authenticated and served {len(orgs)} org(s) from Supabase")
PY

  if [ -n "${web_url}" ]; then
    # The web pod is public and unauthenticated at `/` (the app redirects
    # anonymous visitors to sign-in), so anything outside 2xx/3xx is a broken
    # deployment: a connection failure, a 404, or a 5xx.
    status="$(curl -s -o /dev/null -w '%{http_code}' "${web_url}" || echo 000)"
    case "${status}" in
      2[0-9][0-9] | 3[0-9][0-9])
        echo "Web app reachable (HTTP ${status}): ${web_url}"
        ;;
      *)
        echo "Web app not reachable (HTTP ${status}): ${web_url}" >&2
        return 1
        ;;
    esac
  fi
}

# Verify the Supabase password login the webapp uses (GoTrue token grant). Usage:
#   smoke_login SUPABASE_URL ANON_KEY EMAIL PASSWORD
# Asserts the response carries an access_token (the "login shape") without printing it.
smoke_login() {
  local supabase_url="${1%/}" anon_key="$2" email="$3" password="$4" login_json
  login_json="$(mktemp)"
  curl -fsS "${supabase_url}/auth/v1/token?grant_type=password" \
    -H "apikey: ${anon_key}" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}))' "${email}" "${password}")" \
    -o "${login_json}"
  python3 - "${login_json}" <<'PY'
import json
import sys
from pathlib import Path

session = json.loads(Path(sys.argv[1]).read_text())
assert session.get("access_token"), "login response is missing access_token"
assert session.get("token_type", "").lower() == "bearer", "unexpected token_type in login response"
print("Login: ok (access token issued; value not printed)")
PY
  rm -f "${login_json}"
}

# Verify the /v1 edge is the transparent gateway proxy. Usage:
#   smoke_gateway_edge_surface SERVING_URL API_KEY
# The api proxies /v1 transparently to the gateway worker, which is the auth
# authority. This probe presents the deployment key (EXPLABS_API_KEY), which is
# not an xpl_ customer key the worker admits, so both proxied routes are relayed
# and answered with the worker's OpenAI-shaped 401 (invalid_key) and zero
# provider spend (auth is refused before any dispatch). The Chat Completions
# probe sends Idempotency-Key on purpose: the edge must forward it to the worker
# (reaching the worker's 401) instead of rejecting it at the edge (the old
# pre-gateway 400 would defeat worker-side replay).
smoke_gateway_edge_surface() {
  local base="${1%/}" api_key="$2" body_file status
  body_file="$(mktemp)"
  status="$(curl -sS -o "${body_file}" -w '%{http_code}' \
    -X POST "${base}/v1/responses" \
    -H "Authorization: Bearer ${api_key}" \
    -H "Content-Type: application/json" \
    -d '{}')"
  if [ "${status}" != "401" ]; then
    echo "FAILED: /v1/responses returned HTTP ${status}; expected the worker's 401" >&2
    rm -f "${body_file}"
    return 1
  fi
  EXPECTED_CODE=invalid_key python3 - "${body_file}" <<'PY'
import json
import os
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
error = payload.get("error", {})
assert error.get("code") == os.environ["EXPECTED_CODE"], payload
PY

  status="$(curl -sS -o "${body_file}" -w '%{http_code}' \
    -X POST "${base}/v1/chat/completions" \
    -H "Authorization: Bearer ${api_key}" \
    -H "Idempotency-Key: smoke-must-be-forwarded" \
    -H "Content-Type: application/json" \
    --data-binary 'not-json')"
  if [ "${status}" != "401" ]; then
    echo "FAILED: caller idempotency short-circuited with HTTP ${status}; expected the worker's relayed 401" >&2
    rm -f "${body_file}"
    return 1
  fi
  EXPECTED_CODE=invalid_key python3 - "${body_file}" <<'PY'
import json
import os
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
error = payload.get("error", {})
assert error.get("code") == os.environ["EXPECTED_CODE"], payload
PY

  # The Anthropic Messages lane: x-api-key must be admitted by the edge (no
  # Authorization header at all) and the worker's 401 must wear Anthropic's
  # envelope, not OpenAI's. Still zero provider spend: auth refuses first.
  status="$(curl -sS -o "${body_file}" -w '%{http_code}' \
    -X POST "${base}/v1/messages" \
    -H "x-api-key: ${api_key}" \
    -H "anthropic-version: 2023-06-01" \
    -H "Content-Type: application/json" \
    -d '{}')"
  if [ "${status}" != "401" ]; then
    echo "FAILED: /v1/messages returned HTTP ${status}; expected the worker's 401" >&2
    rm -f "${body_file}"
    return 1
  fi
  python3 - "${body_file}" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
assert payload.get("type") == "error", payload
assert payload.get("error", {}).get("type") == "authentication_error", payload
PY
  rm -f "${body_file}"
  echo "Serving edge: transparent gateway proxy relays to the worker (worker owns auth)"
}

# Verify the WEB pod can reach Supabase with the service role. Usage:
#   smoke_web_service_role WEB_URL
# The signed-out site renders happily without that key, so a deploy that drops it
# looks green from every api-side probe here while no customer can get in: the
# unified /signin needs the service role to tell "no account yet" from "wrong
# password", and without it degrades to the generic rejection, so a first-time
# visitor is told "Invalid email or password" and signup is dead. This asks the
# web app about an address that cannot exist. A working deploy answers 404
# account_not_found (or 403 signup_disabled where signups are gated - reaching
# that branch already proves the lookup succeeded). A 401 is the degrade path and
# means the key never arrived.
smoke_web_service_role() {
  local web_url="${1%/}" probe_email body_file status
  # Random local part: a real account with this address would invalidate the probe.
  probe_email="smoke-probe-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')@invalid.experientiallabs.ai"
  body_file="$(mktemp)"
  status="$(
    curl -sS -o "${body_file}" -w '%{http_code}' \
      -X POST "${web_url}/auth/signin" \
      -H "Content-Type: application/json" \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": "smoke-probe-not-a-real-password"}))' "${probe_email}")"
  )"
  if [ "${status}" = "404" ] || [ "${status}" = "403" ]; then
    echo "Web service role: ok (/signin resolved an unknown address, HTTP ${status})"
    rm -f "${body_file}"
    return 0
  fi
  echo "=================================================================="
  echo "FAILED: ${web_url}/signin answered HTTP ${status} for an address that"
  echo "cannot exist. Expected 404 account_not_found."
  if [ "${status}" = "401" ]; then
    echo
    echo "401 is the service-role degrade path: the web pod could not run the"
    echo "signin_methods_for_email lookup, so it cannot tell a new visitor from"
    echo "a wrong password. SIGNUP IS BROKEN. Check that the web app carries"
    echo "SUPABASE_SERVICE_ROLE_KEY."
  fi
  echo "Response body:"
  cat "${body_file}"
  echo
  echo "=================================================================="
  rm -f "${body_file}"
  return 1
}

# Wait for a freshly rolled deployment to start serving before probing it.
# Usage: smoke_wait_ready URL [BUDGET_SECONDS]
# A rolling deploy returns when the new revision is accepted, not when it is
# serving: fresh containers pull images and pass probes for a minute or two
# after, and a front door with zero ready backends answers 502/503. A smoke
# that fires inside that window fails a deploy that was fine. Any HTTP status
# counts as ready - the probes that follow judge correctness; this only waits
# for SOMETHING to answer. The budget keeps a genuinely dead deploy loudly
# failing.
smoke_wait_ready() {
  local url="${1%/}" budget="${2:-240}" deadline code
  deadline=$(( $(date +%s) + budget ))
  while :; do
    # Assign first, then overwrite on transport failure: curl -w prints 000
    # itself on most connect errors, and `|| echo 000` inside the substitution
    # would CONCATENATE with it ("000000"), dodging the retry branch below.
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${url}" 2>/dev/null)" || code="000"
    case "${code}" in
      000|502|503|504) ;;
      *)
        echo "Ready: ${url} answers HTTP ${code}"
        return 0
        ;;
    esac
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "FAILED: ${url} still answers ${code} after ${budget}s; the deploy did not come up." >&2
      return 1
    fi
    sleep 10
  done
}
