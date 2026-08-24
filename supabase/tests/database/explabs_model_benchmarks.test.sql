-- model_benchmarks: one row per (model, benchmark) measurement, uuid-keyed so
-- dedup slug renames never detach a score, service-role only like the rest of
-- the catalog. These tests pin the shape, the provenance constraint, the
-- upsert key, and the delete cascade.

begin;

create extension if not exists pgtap with schema extensions;

select plan(20);

select has_table('public', 'model_benchmarks', 'the model_benchmarks table exists');

select columns_are(
  'public',
  'model_benchmarks',
  array[
    'id',
    'model_id',
    'benchmark',
    'score',
    'source',
    'source_url',
    'retrieved_at',
    'created_at',
    'updated_at'
  ],
  'model_benchmarks carries exactly the measurement columns'
);

-- Scratch fixture: one public model to hang scores on.
insert into public.models (slug, display_name) values
  ('bench-test-model', 'Bench Test Model');

-- A well-formed row inserts.
select lives_ok(
  $$
    insert into public.model_benchmarks
      (model_id, benchmark, score, source, source_url, retrieved_at)
    select m.id, 'mmlu-pro', 81.2, 'vendor',
           'https://example.com/model-card', now()
    from public.models m
    where m.slug = 'bench-test-model' and m.owning_org_id is null
  $$,
  'a well-formed benchmark row inserts'
);

-- The upsert key: one current score per (model, benchmark).
select throws_ok(
  $$
    insert into public.model_benchmarks
      (model_id, benchmark, score, source, retrieved_at)
    select m.id, 'mmlu-pro', 79.0, 'paper', now()
    from public.models m
    where m.slug = 'bench-test-model' and m.owning_org_id is null
  $$,
  '23505',
  null,
  'a second score for the same (model, benchmark) violates the upsert key'
);

-- Provenance is a closed vocabulary, widened additively like stats_source.
select throws_ok(
  $$
    insert into public.model_benchmarks
      (model_id, benchmark, score, source, retrieved_at)
    select m.id, 'gpqa-diamond', 60.0, 'artificialanalysis', now()
    from public.models m
    where m.slug = 'bench-test-model' and m.owning_org_id is null
  $$,
  '23514',
  null,
  'an unknown provenance source is rejected'
);

-- Benchmark keys stay URL-safe (same shape rules as models.slug).
select throws_ok(
  $$
    insert into public.model_benchmarks
      (model_id, benchmark, score, source, retrieved_at)
    select m.id, 'MMLU Pro', 81.2, 'vendor', now()
    from public.models m
    where m.slug = 'bench-test-model' and m.owning_org_id is null
  $$,
  '23514',
  null,
  'a non-slug benchmark key is rejected'
);

-- Scores are raw published figures; negative figures are recording errors.
select throws_ok(
  $$
    insert into public.model_benchmarks
      (model_id, benchmark, score, source, retrieved_at)
    select m.id, 'gpqa-diamond', -1, 'vendor', now()
    from public.models m
    where m.slug = 'bench-test-model' and m.owning_org_id is null
  $$,
  '23514',
  null,
  'a negative score is rejected'
);

-- Citations are https links when present.
select throws_ok(
  $$
    insert into public.model_benchmarks
      (model_id, benchmark, score, source, source_url, retrieved_at)
    select m.id, 'aime-2026', 90.0, 'vendor', 'ftp://example.com', now()
    from public.models m
    where m.slug = 'bench-test-model' and m.owning_org_id is null
  $$,
  '23514',
  null,
  'a non-https citation is rejected'
);

-- Host labels must start and end alphanumeric: dot-led and dash-led hosts
-- are malformed, not citations.
select throws_ok(
  $$
    insert into public.model_benchmarks
      (model_id, benchmark, score, source, source_url, retrieved_at)
    select m.id, 'math-500', 88.0, 'vendor', 'https://..com', now()
    from public.models m
    where m.slug = 'bench-test-model' and m.owning_org_id is null
  $$,
  '23514',
  null,
  'a dot-led citation host is rejected'
);

-- The checks are end-anchored: a valid prefix followed by junk is not a URL.
select throws_ok(
  $$
    insert into public.model_benchmarks
      (model_id, benchmark, score, source, source_url, retrieved_at)
    select m.id, 'mmlu', 80.0, 'vendor', 'https://example.com/ not-a-url', now()
    from public.models m
    where m.slug = 'bench-test-model' and m.owning_org_id is null
  $$,
  '23514',
  null,
  'a citation with trailing junk after the URL is rejected'
);

-- The shared trigger keeps updated_at honest on plain service-role DML.
-- (now() is constant inside this transaction, so the row is inserted with a
-- deliberately stale updated_at and the trigger must overwrite it.)
insert into public.model_benchmarks
  (model_id, benchmark, score, source, retrieved_at, updated_at)
select m.id, 'livebench', 70.0, 'leaderboard', now(), '2000-01-01'
from public.models m
where m.slug = 'bench-test-model' and m.owning_org_id is null;

update public.model_benchmarks set score = 71.0 where benchmark = 'livebench';

select is(
  (select b.updated_at = now() from public.model_benchmarks b
   where b.benchmark = 'livebench'),
  true,
  'updates refresh updated_at via the shared trigger'
);

-- Deleting the model cascades to its scores.
delete from public.models
where slug = 'bench-test-model' and owning_org_id is null;

select is(
  (select count(*)::integer from public.model_benchmarks b
   where b.benchmark = 'mmlu-pro'
     and not exists (select 1 from public.models m where m.id = b.model_id)),
  0,
  'deleting the model cascades to its benchmark rows'
);

-- Locked down like the rest of the catalog: service-role only.
select is(
  (select relrowsecurity from pg_class
   where oid = 'public.model_benchmarks'::regclass),
  true,
  'row level security is enabled'
);

select is(
  (select count(*)::integer from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'model_benchmarks'
     and grantee in ('anon', 'authenticated')),
  0,
  'browser roles hold no grants'
);

-- Release links on models: the HF check pins the huggingface.co host and a
-- non-empty repo path; release_url and source_url require a real dotted host
-- so a bare scheme never persists.
select throws_ok(
  $$
    insert into public.models (slug, display_name, huggingface_url) values
      ('bench-test-hf', 'Bench Test HF', 'https://example.com/not-hf')
  $$,
  '23514',
  null,
  'huggingface_url must point at huggingface.co'
);

-- A bare org page is not a repository: the path needs the org/repo separator.
select throws_ok(
  $$
    insert into public.models (slug, display_name, huggingface_url) values
      ('bench-test-hf2', 'Bench Test HF 2', 'https://huggingface.co/meta-llama')
  $$,
  '23514',
  null,
  'a namespace-only huggingface_url is rejected'
);

-- Degenerate repo segments are not repositories: dot-only and empty
-- segments fail because both org and repo must lead alphanumeric.
select throws_ok(
  $$
    insert into public.models (slug, display_name, huggingface_url) values
      ('bench-test-hf3', 'Bench Test HF 3', 'https://huggingface.co/org/..')
  $$,
  '23514',
  null,
  'a dot-only huggingface repo segment is rejected'
);

select throws_ok(
  $$
    insert into public.models (slug, display_name, huggingface_url) values
      ('bench-test-hf4', 'Bench Test HF 4', 'https://huggingface.co/org//repo')
  $$,
  '23514',
  null,
  'a double-slash huggingface path is rejected'
);

select throws_ok(
  $$
    insert into public.models (slug, display_name, release_url) values
      ('bench-test-rel', 'Bench Test Rel', 'https://')
  $$,
  '23514',
  null,
  'a bare https scheme is not a release link'
);

select throws_ok(
  $$
    insert into public.models (slug, display_name, release_url) values
      ('bench-test-rel2', 'Bench Test Rel 2', 'https://-vendor.com/release')
  $$,
  '23514',
  null,
  'a dash-led release host is rejected'
);

select * from finish();

rollback;
