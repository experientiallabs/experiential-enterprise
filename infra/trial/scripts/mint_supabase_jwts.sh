#!/usr/bin/env bash
# Copyright (c) 2026 Experiential Labs. All rights reserved.
#
# Mint a fresh Supabase JWT secret plus the matching anon and service_role
# HS256 JWTs, using only openssl, base64url via tr, and printf. The well-known
# supabase-demo tokens in docker/.env.example must never face the internet;
# every trial VM runs this once at first boot and persists the result.
#
# Output: three KEY=VALUE lines on stdout, ready for an env file:
#   SUPABASE_JWT_SECRET=...
#   SUPABASE_ANON_KEY=...
#   SUPABASE_SERVICE_ROLE_KEY=...
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
echo "Minting Supabase JWT secret and keys for ${repo_root}" >&2

# base64url without padding, as RFC 7515 requires for JWT segments.
b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

jwt_secret="$(openssl rand -hex 32)"
issued_at="$(date +%s)"
# Ten years: the trial stack has no key-rotation story, and GoTrue, PostgREST,
# and storage-api all reject an expired token outright.
expires_at=$((issued_at + 315360000))

header_b64="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"

# Mint one signed token for the given Postgres role claim.
mint_token() {
  local role="$1"
  local payload_b64 signature_b64
  payload_b64="$(printf '{"iss":"supabase","role":"%s","iat":%s,"exp":%s}' \
    "${role}" "${issued_at}" "${expires_at}" | b64url)"
  signature_b64="$(printf '%s' "${header_b64}.${payload_b64}" \
    | openssl dgst -sha256 -hmac "${jwt_secret}" -binary | b64url)"
  printf '%s.%s.%s' "${header_b64}" "${payload_b64}" "${signature_b64}"
}

printf 'SUPABASE_JWT_SECRET=%s\n' "${jwt_secret}"
printf 'SUPABASE_ANON_KEY=%s\n' "$(mint_token anon)"
printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "$(mint_token service_role)"

echo "Minted anon and service_role JWTs (HS256, 10-year expiry)" >&2
