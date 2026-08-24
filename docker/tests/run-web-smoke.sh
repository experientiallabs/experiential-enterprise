#!/usr/bin/env sh
# Web smoke for the gateway UI: health, login page render (new branding,
# no optimizer-era copy), /models rendering signed-out behind the
# connect-a-provider gate, auth gating on the APIs, the authenticated orgs API
# listing the seeded demo-examples org, the "/" fork landing members on their
# Overview, plus every legacy redirect terminating at /models.
set -eu

web_url="${WEB_URL:-http://web:3000}"
auth_url="${AUTH_URL:-http://supabase-auth:9999}"
admin_email="${EXPLABS_AUTH_ADMIN_EMAIL:?EXPLABS_AUTH_ADMIN_EMAIL must be set}"
admin_password="${EXPLABS_AUTH_ADMIN_PASSWORD:?EXPLABS_AUTH_ADMIN_PASSWORD must be set}"
# @supabase/ssr derives the auth cookie name from the web app's SUPABASE_URL
# host (http://supabase-kong:8000 -> sb-supabase-kong-auth-token).
cookie_name="${SUPABASE_AUTH_COOKIE_NAME:-sb-supabase-kong-auth-token}"

assert_contains() {
  body="$1"
  expected="$2"
  label="$3"
  if ! printf '%s' "${body}" | grep -F "${expected}" >/dev/null; then
    echo "FAIL: ${label} did not contain ${expected}" >&2
    exit 1
  fi
}

health_body="$(wget -qO- "${web_url}/api/health")"
assert_contains "${health_body}" '"status":"healthy"' "web health response"

login_page="$(wget -qO- "${web_url}/login")"
assert_contains "${login_page}" 'Sign in' "login page"
if echo "${login_page}" | grep -i 'optimizer' >/dev/null; then
  echo "login page still mentions optimizer-era branding" >&2
  exit 1
fi

if wget -qO- "${web_url}/api/orgs" >/dev/null 2>&1; then
  echo "expected /api/orgs to require auth" >&2
  exit 1
fi

# /models is the public door, but this build gates the catalog DISPLAY on a
# provider connection. The stack seeds none, so every storefront render below
# must show the connect-a-provider prompt (the stable server-rendered marker)
# with no sign-in bounce anywhere in the payload.
models_door="$(wget -qO- "${web_url}/models")"
assert_contains "${models_door}" 'Connect a provider to see models' "signed-out Models catalog"
if echo "${models_door}" | grep -q 'signin?next='; then
  echo "FAIL: signed-out /models still bounces to sign-in" >&2
  exit 1
fi

# Model detail is public too: one URL for both audiences, actions gate later.
# claude-opus-5 is a seeded public catalog row (supabase/seed-gateway-catalog.sql);
# "Open in Playground" is the detail page's stable server-rendered action.
model_page="$(wget -qO- "${web_url}/models/claude-opus-5")"
assert_contains \
  "${model_page}" \
  'Open in Playground' \
  "signed-out Model detail"

# The retired Simulation surface permanently redirects to /models. BusyBox
# wget follows the 308 and lands on the gated storefront.
gated_simulations="$(wget -qO- "${web_url}/simulations")"
assert_contains "${gated_simulations}" 'Connect a provider to see models' "signed-out Simulations redirect"

# Sign in against GoTrue directly (inside the network it is not behind Kong's
# key-auth) and present the session to the web app as the Supabase SSR cookie:
# "base64-" + base64url(session JSON).
session_json="$(
  wget -qO- \
    --header 'Content-Type: application/json' \
    --post-data "{\"email\":\"${admin_email}\",\"password\":\"${admin_password}\"}" \
    "${auth_url}/token?grant_type=password"
)"
assert_contains "${session_json}" '"access_token"' "local auth response"

cookie_value="base64-$(printf '%s' "${session_json}" | base64 | tr -d '=\n' | tr '+/' '-_')"

# GET /api/orgs returns a bare array of org records.
orgs_json="$(
  wget -qO- --header "Cookie: ${cookie_name}=${cookie_value}" "${web_url}/api/orgs"
)"
assert_contains "${orgs_json}" '"demo-examples"' "authenticated org listing"

# The active org is server-side state (the "explabs-active-org" cookie); set it
# explicitly so the authenticated redirect smoke is deterministic.
active_org_cookie="explabs-active-org"
demo_org_id="$(
  printf '%s' "${orgs_json}" |
    tr '}' '\n' |
    grep '"slug":"demo-examples"' |
    grep -o '"id":"[0-9a-f-]\{36\}"' |
    grep -o '[0-9a-f-]\{36\}'
)"
if [ -z "${demo_org_id}" ]; then
  echo "could not extract demo-examples org id from /api/orgs" >&2
  exit 1
fi

session_cookies="${cookie_name}=${cookie_value}; ${active_org_cookie}=demo-examples"

# "/" forks by audience: a member lands on the personal Overview. The redirect
# may surface as a followed 3xx (body: the Overview stub's copy) or as the 200
# shell carrying the redirect payload (body: the "/overview" target); the
# lowercase marker appears in both forms.
home_fork="$(
  wget -qO- --header "Cookie: ${session_cookies}" "${web_url}/"
)"
assert_contains "${home_fork}" 'overview' "authenticated home fork to Overview"

simulations_page="$(
  wget -qO- --header "Cookie: ${session_cookies}" "${web_url}/simulations"
)"
assert_contains "${simulations_page}" 'Connect a provider to see models' "authenticated Simulations redirect"
if echo "${simulations_page}" | grep -q 'href="/simulations'; then
  echo "FAIL: page reached from /simulations still links to Simulations" >&2
  exit 1
fi

# Legacy Models and world-model URLs terminate at the same catalog surface for
# members as for visitors.
models_redirect_page="$(
  wget -qO- --header "Cookie: ${session_cookies}" "${web_url}/models"
)"
assert_contains "${models_redirect_page}" 'Connect a provider to see models' "authenticated Models catalog"
renamed_redirect_page="$(
  wget -qO- --header "Cookie: ${session_cookies}" "${web_url}/world-models"
)"
assert_contains "${renamed_redirect_page}" 'Connect a provider to see models' "renamed world-models redirect"
legacy_redirect_page="$(
  wget -qO- --header "Cookie: ${session_cookies}" \
    "${web_url}/orgs/${demo_org_id}/world-models"
)"
assert_contains "${legacy_redirect_page}" 'Connect a provider to see models' "legacy org world-models redirect"

echo "web smoke passed"
