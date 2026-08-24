-- Admin-managed recommended models. The catalog's "Recommended" band is the
-- set of public models carrying a non-null models.preferred_rank; until now
-- the seed hardcoded it (seed-gateway-catalog.sql section 8). This function
-- makes the set a runtime admin resource: one definer call replaces the WHOLE
-- ordered set atomically — ranks 0..N-1 assigned in list order on exactly the
-- named public (owning_org_id null) models, and the pin cleared on every other
-- public model. PostgREST cannot span the clear and the assignment, and every
-- partial order of separate statements is wrong somewhere: clear-then-rank can
-- die leaving an empty band (which the seed guard reads as "fresh database"),
-- rank-then-clear can briefly star models the admin just dropped.
--
-- Write paths: PUT /api/admin/recommended-models (platform-admin sessions and
-- xpladmin_ superadmin keys) via the web Recommended card on /admin/promotions.
-- The seed only applies its default list when NO public model is ranked, so a
-- re-seed never clobbers a set written through this function.

create function public.recommended_models_apply(p_slugs pg_catalog.text[])
returns table (
  slug pg_catalog.text,
  display_name pg_catalog.text,
  preferred_rank pg_catalog.int4
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_missing pg_catalog.text[];
begin
  perform public.gateway_require_service_role();
  -- Serialize whole-set replacements: this function clears every public
  -- model's rank and then sets the chosen ones, two statements that must not
  -- interleave with a concurrent apply (which would leave a torn band from
  -- one call's clear crossing the other's set). A transaction-scoped advisory
  -- lock on a fixed key makes concurrent admin saves last-writer-wins over the
  -- WHOLE set rather than a mix. The key is an arbitrary constant unique to
  -- this function.
  perform pg_catalog.pg_advisory_xact_lock(778130291);
  -- An empty set is refused, not applied: a catalog with no ranked public
  -- model is exactly what the seed treats as "fresh", so an admin-cleared
  -- band would be silently restored to the defaults on the next re-seed.
  -- The storefront also assumes a recommended band exists.
  if p_slugs is null or pg_catalog.cardinality(p_slugs) = 0 then
    raise exception using errcode = '22023',
      message = 'recommended set must name at least one model slug';
  end if;
  -- List order IS the rank order; a duplicate slug would make its rank
  -- nondeterministic, so refuse instead of picking one occurrence.
  if (select pg_catalog.count(distinct s.slug) from pg_catalog.unnest(p_slugs) s(slug))
      <> pg_catalog.cardinality(p_slugs) then
    raise exception using errcode = '22023',
      message = 'recommended slugs must be unique: list order defines the rank';
  end if;
  -- This raise is the single unknown-slug authority (callers do no
  -- read-then-write pre-check), so a concurrent model delete cannot race a
  -- stale existence answer into a partial apply.
  select pg_catalog.array_agg(s.slug order by s.ord) into v_missing
  from pg_catalog.unnest(p_slugs) with ordinality s(slug, ord)
  where not exists (
    select 1 from public.models m
    where m.slug = s.slug and m.owning_org_id is null
  );
  if v_missing is not null then
    raise exception using errcode = 'P0002',
      message = pg_catalog.format(
        'unknown public model slugs: %s',
        pg_catalog.array_to_string(v_missing, ', ')
      );
  end if;
  update public.models m set preferred_rank = null
  where m.owning_org_id is null and m.preferred_rank is not null
    and m.slug <> all (p_slugs);
  update public.models m set preferred_rank = (s.ord - 1)::pg_catalog.int4
  from pg_catalog.unnest(p_slugs) with ordinality s(slug, ord)
  where m.owning_org_id is null and m.slug = s.slug
    and m.preferred_rank is distinct from (s.ord - 1)::pg_catalog.int4;
  return query
    select m.slug, m.display_name, m.preferred_rank
    from public.models m
    where m.owning_org_id is null and m.preferred_rank is not null
    order by m.preferred_rank;
end;
$$;

revoke all on function public.recommended_models_apply(pg_catalog.text[])
  from public, anon, authenticated;
grant execute on function public.recommended_models_apply(pg_catalog.text[])
  to service_role;
