#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

supabase db reset --no-seed
"${repo_root}/scripts/seed_supabase_local.sh"
supabase status -o env
