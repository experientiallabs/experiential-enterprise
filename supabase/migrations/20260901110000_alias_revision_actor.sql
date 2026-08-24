-- Actor attribution for the alias activation chain (F1). Every sensitive
-- alias write arrives over service-role, where authenticated_user_id() is
-- null, so the actor must travel as an explicit RPC parameter — a trigger
-- cannot recover it after the fact. This migration:
--
--   * adds gateway_alias_revisions.created_by (uuid, nullable, no FK — the
--     repo's uuid attribution convention: attribution survives the user row)
--     and api_keys.revoked_by (same convention; mint already persists
--     created_by, revocation was universally unattributed);
--   * re-creates the alias activation chain with a trailing
--     `p_actor uuid default null`, stamping created_by on newly inserted
--     revisions and passing it through the named-alias delegate.
--
-- A defaulted parameter added via `create or replace` would OVERLOAD the old
-- signature, not replace it, leaving PostgREST named-argument resolution
-- ambiguous — so each old signature is dropped first and its grants are
-- restated. Bodies are otherwise byte-for-byte the live definitions
-- (gateway_runtime 20260819190000 for the base pair; named_aliases
-- 20260821090000 for the delegate; no later migration re-created them).

alter table public.gateway_alias_revisions
  add column created_by pg_catalog.uuid;

comment on column public.gateway_alias_revisions.created_by is
  'User who activated this revision (null for pre-attribution rows and system/catalog-builder writes). Attribution only; excluded from the revision content-drift check, so an idempotent replay keeps the first writer.';

alter table public.api_keys
  add column revoked_by pg_catalog.uuid;

comment on column public.api_keys.revoked_by is
  'User who revoked the key (uuid attribution convention, no FK). Written by the revoke API alongside revoked_at; null for pre-attribution revocations.';

-- ---------------------------------------------------------------------------
-- Drop the actor-less chain (exact live signatures), then re-create with the
-- trailing actor. Delegate dropped first only for readability; plpgsql bodies
-- resolve callees at run time, so drop order carries no dependency.

drop function public.gateway_activate_named_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool, pg_catalog.uuid, pg_catalog.text
);

drop function public.gateway_activate_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool
);

drop function public.gateway_deactivate_alias(pg_catalog.text);

-- ---------------------------------------------------------------------------
-- int-p1 activation, body unchanged except the actor plumbing: p_actor is
-- stamped onto newly inserted revisions and deliberately NOT part of the
-- content-drift comparison (attribution is not content).

create function public.gateway_activate_alias_revision(
  p_alias_id pg_catalog.text,
  p_alias_name pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_revision_id pg_catalog.text,
  p_target pg_catalog.jsonb,
  p_catalog_sha256 pg_catalog.text,
  p_provider_connection_revisions pg_catalog.jsonb,
  p_certification pg_catalog.jsonb,
  p_refusal_failover pg_catalog.bool default false,
  p_actor pg_catalog.uuid default null
)
returns table (changed pg_catalog.bool)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alias public.gateway_aliases%rowtype;
  v_revision public.gateway_alias_revisions%rowtype;
begin
  perform public.gateway_require_service_role();
  -- Typed collision so the catalog builder gets a self-explanatory error
  -- instead of a bare unique violation. Namespace-aware: the same name in
  -- another org's namespace (or the public one) is legal shadowing.
  if exists (
    select 1 from public.gateway_aliases aliases
    where aliases.alias_name = p_alias_name
      and aliases.org_id is not distinct from p_org_id
      and aliases.alias_id <> p_alias_id
  ) then
    raise exception using errcode = '23505',
      message = 'alias name is already bound to a different alias id in this namespace';
  end if;
  insert into public.gateway_aliases (alias_id, alias_name, org_id)
  values (p_alias_id, p_alias_name, p_org_id)
  on conflict on constraint gateway_aliases_pkey do nothing;
  -- Concurrent cold-boot safety: everything past this lock is serialized
  -- per alias, so the revision existence check below cannot race a sibling
  -- worker's insert of the same revision (the loser re-reads under a fresh
  -- snapshot and takes the verify path). The bare revision insert stays
  -- bare on purpose: a cross-alias revision-id collision must fail loudly,
  -- not be absorbed by an ON CONFLICT.
  select aliases.* into v_alias
    from public.gateway_aliases aliases
   where aliases.alias_id = p_alias_id
   for update;
  if v_alias.alias_name <> p_alias_name
     or v_alias.org_id is distinct from p_org_id then
    raise exception using errcode = '23505',
      message = 'alias identity drifted: alias_id is bound to another name or organization';
  end if;
  select revisions.* into v_revision
    from public.gateway_alias_revisions revisions
   where revisions.revision_id = p_revision_id;
  if v_revision.revision_id is not null then
    if v_revision.alias_id <> p_alias_id
       or v_revision.target <> p_target
       or v_revision.catalog_sha256 <> p_catalog_sha256
       or v_revision.provider_connection_revisions
         <> p_provider_connection_revisions
       or v_revision.certification is distinct from p_certification
       or v_revision.refusal_failover <> p_refusal_failover then
      raise exception using errcode = '23505',
        message = 'alias revision content drifted for an existing revision id';
    end if;
    -- Operation-receipt spirit: re-activating the active revision is a no-op.
    if v_alias.current_revision_id = p_revision_id and v_alias.active then
      return query select false;
      return;
    end if;
  else
    insert into public.gateway_alias_revisions (
      revision_id, alias_id, target, catalog_sha256,
      provider_connection_revisions, certification, refusal_failover,
      created_by
    ) values (
      p_revision_id, p_alias_id, p_target, p_catalog_sha256,
      p_provider_connection_revisions, p_certification, p_refusal_failover,
      p_actor
    );
  end if;
  update public.gateway_aliases
     set current_revision_id = p_revision_id,
         active = true
   where alias_id = p_alias_id;
  return query select true;
end;
$$;

revoke all on function public.gateway_activate_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.gateway_activate_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool, pg_catalog.uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Named-alias activation (P-E), body unchanged except p_actor passing
-- through to the delegate above.

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
  p_model_slug pg_catalog.text,
  p_actor pg_catalog.uuid default null
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
      p_refusal_failover, p_actor
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
  pg_catalog.bool, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.gateway_activate_named_alias_revision(
  pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.bool, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Retire a model slug from routing. The revision history and the
-- current-revision pointer stay intact, so re-activating the same revision
-- through gateway_activate_alias_revision brings the alias back.
-- p_actor is accepted so the management API passes the actor uniformly
-- across the alias chain, and deliberately unused here: deactivation stamps
-- no row (gateway_aliases carries no attribution column), and the audit
-- record is the caller's record_audit_event emit, keeping this RPC
-- single-purpose.

create function public.gateway_deactivate_alias(
  p_alias_id pg_catalog.text,
  p_actor pg_catalog.uuid default null
)
returns table (changed pg_catalog.bool)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alias public.gateway_aliases%rowtype;
begin
  perform public.gateway_require_service_role();
  select aliases.* into v_alias
    from public.gateway_aliases aliases
   where aliases.alias_id = p_alias_id
   for update;
  if v_alias.alias_id is null then
    raise exception using errcode = 'P0002',
      message = 'alias does not exist';
  end if;
  if not v_alias.active then
    return query select false;
    return;
  end if;
  update public.gateway_aliases
     set active = false
   where alias_id = p_alias_id;
  return query select true;
end;
$$;

revoke all on function public.gateway_deactivate_alias(
  pg_catalog.text, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.gateway_deactivate_alias(
  pg_catalog.text, pg_catalog.uuid
) to service_role;
