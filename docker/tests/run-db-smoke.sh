#!/usr/bin/env sh
set -eu

database_url="${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"

assert_eq() {
  name="$1"
  got="$2"
  want="$3"
  if [ "${got}" != "${want}" ]; then
    echo "db smoke failed: ${name}=${got}, expected ${want}" >&2
    exit 1
  fi
}

org_count="$(psql "${database_url}" -tAc "select count(*) from public.organizations where slug = 'experiential-labs'")"
demo_org_count="$(psql "${database_url}" -tAc "select count(*) from public.organizations where slug = 'demo-examples'")"
# Seeding is create-if-missing, so on a persistent database (preview branches,
# production) the seeded demo rows may have moved on: a built model is
# 'building'/'ready' and its upload 'ingested'. Assert every seeded model
# exists in a healthy state with at least one intact, usable upload. Model
# names are only unique per org, so scope both counts through the seeded
# demo-examples org rather than by name alone.
world_model_count="$(psql "${database_url}" -tAc "select count(*) from public.world_models wm join public.organizations o on o.id = wm.org_id where o.slug = 'demo-examples' and wm.name in ('tau-bench', 'terminal-tasks') and wm.status in ('created', 'building', 'ready')")"
models_with_usable_upload="$(psql "${database_url}" -tAc "select count(distinct wm.name) from public.trace_uploads tu join public.world_models wm on wm.id = tu.world_model_id join public.organizations o on o.id = wm.org_id where o.slug = 'demo-examples' and wm.name in ('tau-bench', 'terminal-tasks') and tu.status in ('uploaded', 'ingested') and tu.byte_size > 0 and tu.sha256 is not null")"

assert_eq "org_count" "${org_count}" "1"
assert_eq "demo_org_count" "${demo_org_count}" "1"
assert_eq "world_model_count" "${world_model_count}" "2"
assert_eq "models_with_usable_upload" "${models_with_usable_upload}" "2"

# RLS sanity: an authenticated session without a membership claim must see no
# world models even though the table has seeded rows. -q keeps the SET command
# tag out of the captured output so only the count remains.
rls_count="$(psql "${database_url}" -q -tAc "set role authenticated; select count(*) from public.world_models;")"
assert_eq "rls_hidden_rows" "${rls_count}" "0"

echo "db smoke passed: orgs=${org_count} demo_orgs=${demo_org_count} world_models=${world_model_count} models_with_usable_upload=${models_with_usable_upload} rls_hidden_rows_ok=1"
