#!/usr/bin/env bash
set -euo pipefail

supabase start
supabase status -o env

