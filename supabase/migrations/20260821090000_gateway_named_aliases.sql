-- Named / abstract aliases (identity tier P-E).
--
-- A named alias is an admin-defined model name (e.g. "coding") whose target is
-- a platform model an admin can repoint over time. The alias mechanism ships
-- whole in int-p1: an alias is a gateway_aliases row with immutable, repointable
-- revisions, activated by gateway_activate_alias_revision, retired by
-- gateway_deactivate_alias, and rolled back by re-activating an older revision
-- (idempotent, content-checked). P-E adds only what those functions do not:
--
--   * a way to mark an alias origin='named' so the catalog builder skips it
--     (P-A added the column; this migration marks the row), and
--   * a record of which platform model each named-alias revision was pointed at,
--     so the management UI can render a readable repoint history and roll back
--     to a prior model.
--
-- The revision mechanics themselves are NOT reimplemented here:
-- gateway_activate_named_alias_revision establishes the origin marker and then
-- DELEGATES create / repoint / rollback to int-p1's
-- gateway_activate_alias_revision. Ordered after P-A's identity tier
-- (20260820090000), which added gateway_aliases.origin.

-- ---------------------------------------------------------------------------
-- 1. Backing model per named-alias revision. A gateway_alias_revisions row
--    stores only a WMO DirectTarget (pool + deployment ids), which does not
--    name the platform model it was synthesized from; this table records that
--    provenance for the repoint-history UI and for rollback. model_id is
--    nullable with ON DELETE SET NULL so deleting a model never wedges a
--    revision's history; model_slug is denormalized so the history stays
--    readable after the model row is gone.

create table public.gateway_named_alias_targets (
  revision_id pg_catalog.text primary key
    references public.gateway_alias_revisions(revision_id) on delete cascade,
  alias_id    pg_catalog.text not null
    references public.gateway_aliases(alias_id) on delete cascade,
  model_id    pg_catalog.uuid
    references public.models(id) on delete set null,
  model_slug  pg_catalog.text not null
    check (pg_catalog.char_length(model_slug) between 1 and 128),
  created_at  pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

create index gateway_named_alias_targets_alias_idx
  on public.gateway_named_alias_targets (alias_id, created_at desc);

comment on table public.gateway_named_alias_targets is
  'Which platform model each named-alias revision was pointed at, for the repoint-history UI and rollback. Written only by gateway_activate_named_alias_revision.';

-- ---------------------------------------------------------------------------
-- 2. Activate a named-alias revision. Marks origin='named' and delegates the
--    revision mechanics (create, repoint, and idempotent rollback all funnel
--    through the same int-p1 function), then records the backing model.

create function public.gateway_activate_named_alias_revision(
  p_alias_id pg_catalog.text,
  p_alias_name pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_revision_id pg_catalog.text,
  p_target pg_catalog.jsonb,
  p_catalog_sha256 pg_catalog.text,
  p_provider_connection_revisions pg_catalog.jsonb,
  p_certification pg_catalog.jsonb,
  p_refusal_failover pg_catalog.bool,
  p_model_id pg_catalog.uuid,
  p_model_slug pg_catalog.text
)
returns table (changed pg_catalog.bool)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.gateway_aliases%rowtype;
  v_changed pg_catalog.bool;
begin
  perform public.gateway_require_service_role();
  -- Named aliases are always organization-scoped: an admin manages them for
  -- one org, and org-scoping is what lets a named row shadow a public slug and
  -- resolve for that org's keys (control_store.py resolution rule).
  if p_org_id is null then
    raise exception using errcode = '23514',
      message = 'named aliases are organization-scoped; org_id is required';
  end if;
  -- Establish the origin='named' marker BEFORE delegating. int-p1's
  -- gateway_activate_alias_revision inserts a missing alias row with the
  -- default origin='catalog', so the marker must already exist for its
  -- ON CONFLICT DO NOTHING to preserve 'named'.
  select aliases.* into v_existing
    from public.gateway_aliases aliases
   where aliases.alias_id = p_alias_id;
  if v_existing.alias_id is null then
    if exists (
      select 1 from public.gateway_aliases aliases
      where aliases.alias_name = p_alias_name
        and aliases.org_id is not distinct from p_org_id
    ) then
      raise exception using errcode = '23505',
        message = 'a model or alias named this already exists in this organization';
    end if;
    insert into public.gateway_aliases (alias_id, alias_name, org_id, origin)
    values (p_alias_id, p_alias_name, p_org_id, 'named');
  elsif v_existing.origin <> 'named' then
    raise exception using errcode = '23505',
      message = 'alias id already exists as a catalog alias; named aliases use a distinct id';
  end if;
  -- Revision mechanics (create / repoint / rollback) are int-p1's, unchanged.
  select revision.changed into v_changed
    from public.gateway_activate_alias_revision(
      p_alias_id, p_alias_name, p_org_id, p_revision_id, p_target,
      p_catalog_sha256, p_provider_connection_revisions, p_certification,
      p_refusal_failover
    ) as revision;
  -- Record the backing model for the history UI. Append-only per revision, so
  -- an idempotent rollback (re-activating an existing revision) is a no-op here.
  insert into public.gateway_named_alias_targets (
    revision_id, alias_id, model_id, model_slug
  ) values (p_revision_id, p_alias_id, p_model_id, p_model_slug)
  on conflict (revision_id) do nothing;
  return query select v_changed;
end;
$$;

revoke all on function public.gateway_activate_named_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool, pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_activate_named_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool, pg_catalog.uuid, pg_catalog.text
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Row security. Mirror int-p1's alias tables: the runtime only READS this
--    provenance (as postgres, bypassing RLS); the management API writes it
--    through the definer function above, never directly.

alter table public.gateway_named_alias_targets enable row level security;

revoke all on table public.gateway_named_alias_targets
  from public, anon, authenticated, service_role;

grant select on table public.gateway_named_alias_targets to service_role;
