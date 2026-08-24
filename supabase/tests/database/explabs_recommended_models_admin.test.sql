-- Admin-managed recommended models (public.recommended_models_apply): one
-- definer call replaces the WHOLE ordered set — ranks 0..N-1 in list order on
-- exactly the named public models, every other public model unpinned — and
-- refuses the inputs that would make the band ambiguous (unknown slugs,
-- duplicates) or indistinguishable from a fresh database (an empty set, which
-- the seed guard would silently overwrite with the defaults on re-seed).
-- Runs against a seeded database, so the seed's default band is real state
-- these applies must displace.

begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

-- Scratch fixtures: two public models plus an org-owned row whose slug exists
-- in no public namespace (org rows are never eligible for the public band).
insert into public.models (slug, display_name) values
  ('rec-test-alpha', 'Rec Test Alpha'),
  ('rec-test-beta', 'Rec Test Beta');
insert into public.models (slug, display_name, owning_org_id) values
  ('rec-test-org-only', 'Rec Test Org Only', '00000000-0000-0000-0000-000000000004');

-- The apply returns the new set in list order.
select is(
  (
    select array_agg(applied.slug order by applied.preferred_rank)
    from public.recommended_models_apply(array['rec-test-beta', 'rec-test-alpha']) applied
  ),
  array['rec-test-beta', 'rec-test-alpha'],
  'apply returns the whole recommended set in list order'
);

-- State: exactly the named public models are ranked afterward, 0..N-1.
select is(
  (
    select array_agg(m.slug order by m.preferred_rank)
    from public.models m
    where m.owning_org_id is null and m.preferred_rank is not null
  ),
  array['rec-test-beta', 'rec-test-alpha'],
  'exactly the applied models carry a rank afterward'
);

select is(
  (
    select array_agg(m.preferred_rank order by m.preferred_rank)
    from public.models m
    where m.owning_org_id is null and m.preferred_rank is not null
  ),
  array[0, 1],
  'ranks are assigned 0..N-1 in list order'
);

-- The seed's default band was displaced by the whole-set replace.
select is(
  (
    select m.preferred_rank from public.models m
    where m.slug = 'ox-alpha' and m.owning_org_id is null
  ),
  null::integer,
  'a model outside the applied list loses its pin (seeded ox-alpha unpinned)'
);

-- A second apply reorders the same set in place.
select is(
  (
    select array_agg(applied.slug order by applied.preferred_rank)
    from public.recommended_models_apply(array['rec-test-alpha', 'rec-test-beta']) applied
  ),
  array['rec-test-alpha', 'rec-test-beta'],
  'a second apply reorders the same set'
);

-- Org-owned rows are never eligible: slugs resolve only against the public
-- namespace, and the raise names every missing slug for the API's 400.
select throws_ok(
  $$select * from public.recommended_models_apply(array['rec-test-org-only'])$$,
  'P0002',
  'unknown public model slugs: rec-test-org-only',
  'an org-owned slug is unknown to the public recommended set'
);

-- An empty set is refused, not applied: a catalog with no ranked public model
-- is exactly what the seed guard treats as fresh.
select throws_ok(
  $$select * from public.recommended_models_apply(array[]::text[])$$,
  '22023',
  'recommended set must name at least one model slug',
  'an empty recommended set is refused'
);

-- Duplicates are refused: list order defines the rank, so a repeated slug has
-- no deterministic position.
select throws_ok(
  $$select * from public.recommended_models_apply(array['rec-test-alpha', 'rec-test-alpha'])$$,
  '22023',
  'recommended slugs must be unique: list order defines the rank',
  'duplicate slugs are refused'
);

select * from finish();

rollback;
