-- The orphaned-fold drop migration (20260822160000) must delete Project-era
-- fold artifacts whose backing `endpoints` row is GONE (the case
-- 20260819180000 could not reach), while sparing every legitimately-added
-- org-owned local model — WITHOUT relying on the endpoints join.
--
-- The endpoints-independent discriminator is the fold's own invariant:
-- model_providers.provider_model_id = models.slug (both were the endpoint name),
-- on a local host_managed owned model. A legitimate local variant carries an
-- org-namespaced slug and the customer's own wire id, so provider_model_id !=
-- slug and it survives — proven here in the adversarial host_managed case, with
-- NO endpoints rows present at all, so only the slug=wire-id invariant can spare
-- it. This runs the ACTUAL migration file via \ir so the assertions guard the
-- shipped predicate.

begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

insert into public.organizations (id, slug, name)
values ('cf000000-0000-0000-0000-000000000001', 'orphan-fold-org', 'Orphan Fold Org');

-- (b) An ORPHANED fold artifact: the fold shape (owned, local host_managed,
-- provider_model_id = slug) but with NO backing `endpoints` row — the exact
-- production case the earlier endpoints-join migration leaves behind.
insert into public.models (id, slug, display_name, category, owning_org_id)
values (
  'cf000000-0000-0000-0000-000000000021',
  'customer-support',
  'Customer Support',
  'owned',
  'cf000000-0000-0000-0000-000000000001'
);
insert into public.model_providers (
  id, model_id, provider, provider_model_id, base_url, owning_org_id,
  billing_source, capabilities
)
values (
  'cf000000-0000-0000-0000-000000000031',
  'cf000000-0000-0000-0000-000000000021',
  'local',
  'customer-support',
  'http://explabs-project-serving-production-project-serving.default.svc.cluster.local:8080',
  'cf000000-0000-0000-0000-000000000001',
  'host_managed',
  '{"supports_streaming": true}'::jsonb
);

-- (a) A legitimate org-owned local variant, seeded host_managed on purpose:
-- org-namespaced slug, customer's own wire id (provider_model_id != slug), no
-- endpoints row anywhere. Only the slug=wire-id invariant can spare it.
insert into public.models (id, slug, display_name, category, owning_org_id)
values (
  'cf000000-0000-0000-0000-000000000022',
  'orphan-fold-org__qwen3-max',
  'Qwen3 Max (self-hosted)',
  'owned',
  'cf000000-0000-0000-0000-000000000001'
);
insert into public.model_providers (
  id, model_id, provider, provider_model_id, base_url, owning_org_id,
  billing_source, capabilities
)
values (
  'cf000000-0000-0000-0000-000000000032',
  'cf000000-0000-0000-0000-000000000022',
  'local',
  'qwen3-max',
  'https://vllm.internal:8000/v1',
  'cf000000-0000-0000-0000-000000000001',
  'host_managed',
  '{"supports_streaming": true}'::jsonb
);

-- (a2) A legitimate customer_managed local variant whose provider_model_id
-- coincidentally EQUALS its slug (a customer may name both the same). It is not
-- a fold: billing_source is customer_managed, so it must survive.
insert into public.models (id, slug, display_name, category, owning_org_id)
values (
  'cf000000-0000-0000-0000-000000000023',
  'my-router',
  'My Router (self-hosted)',
  'owned',
  'cf000000-0000-0000-0000-000000000001'
);
insert into public.model_providers (
  id, model_id, provider, provider_model_id, base_url, owning_org_id,
  billing_source, capabilities
)
values (
  'cf000000-0000-0000-0000-000000000033',
  'cf000000-0000-0000-0000-000000000023',
  'local',
  'my-router',
  'https://router.internal:8000/v1',
  'cf000000-0000-0000-0000-000000000001',
  'customer_managed',
  '{"supports_streaming": true}'::jsonb
);

-- Run the shipped migration against the seeded rows.
\ir ../../migrations/20260822170000_drop_orphaned_folded_owned_models.sql

select is(
  (select count(*)::int from public.models
   where id = 'cf000000-0000-0000-0000-000000000021'),
  0,
  'the orphaned fold artifact (no endpoints row) is deleted'
);

select is(
  (select count(*)::int from public.model_providers
   where id = 'cf000000-0000-0000-0000-000000000031'),
  0,
  'the orphaned fold deployment cascades with its model'
);

select is(
  (select count(*)::int from public.models
   where id = 'cf000000-0000-0000-0000-000000000022'),
  1,
  'a host_managed local variant with provider_model_id != slug survives'
);

select is(
  (select count(*)::int from public.model_providers
   where id = 'cf000000-0000-0000-0000-000000000032'),
  1,
  'that legitimate variant deployment survives'
);

select is(
  (select count(*)::int from public.models
   where id = 'cf000000-0000-0000-0000-000000000023'),
  1,
  'a customer_managed local variant is spared even when provider_model_id = slug'
);

select is(
  (select count(*)::int from public.model_providers
   where id = 'cf000000-0000-0000-0000-000000000033'),
  1,
  'that customer_managed variant deployment survives'
);

select * from finish();

rollback;
