-- The legacy-fold drop migration (20260819180000) must delete ONLY the
-- Project-era fold artifacts and SPARE legitimately-added org-owned local
-- models (the "add a local variant" / add-a-way flow).
--
-- A fold artifact is a projection of a retained `endpoints` row: the old
-- fold_legacy_endpoints seed created, per ready endpoint, an org-owned
-- `models` row whose slug IS the endpoint name plus a local host_managed
-- `model_providers` row whose provider_model_id is that same endpoint name,
-- pointed at the Project-serving origin. A legitimate local variant shares the
-- coarse shape (category='owned', owning_org_id set, a local deployment) but is
-- not a projection of any endpoint: its slug is org-namespaced, its wire id and
-- base_url are the customer's own, and no `endpoints` row shares its
-- (org, slug).
--
-- This test seeds both against the migrated schema, runs the ACTUAL migration
-- file (via \ir, so the assertions guard the shipped predicate, not a copy),
-- and asserts the fold row (and its cascaded deployment) is gone while every
-- legitimate variant survives. To prove the discriminator is the `endpoints`
-- linkage rather than billing_source, the legitimate variants are seeded in the
-- adversarial worst case (host_managed) that the coarse predicate would delete.

begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

insert into public.organizations (id, slug, name)
values ('bf000000-0000-0000-0000-000000000001', 'fold-scope-org', 'Fold Scope Org');

-- A retained Project-era endpoint (history-only; never independently deleted).
insert into public.endpoints (id, org_id, name, status, policy)
values (
  'bf000000-0000-0000-0000-000000000011',
  'bf000000-0000-0000-0000-000000000001',
  'customer-support',
  'ready',
  '{}'::jsonb
);

-- (b) The fold artifact: slug = endpoint name, local host_managed deployment
-- whose provider_model_id = the endpoint name, pointed at the serving origin.
insert into public.models (id, slug, display_name, category, owning_org_id)
values (
  'bf000000-0000-0000-0000-000000000021',
  'customer-support',
  'Customer Support',
  'owned',
  'bf000000-0000-0000-0000-000000000001'
);
insert into public.model_providers (
  id, model_id, provider, provider_model_id, base_url, owning_org_id,
  billing_source, capabilities
)
values (
  'bf000000-0000-0000-0000-000000000031',
  'bf000000-0000-0000-0000-000000000021',
  'local',
  'customer-support',
  -- The real Project-serving origin the fold pointed at (production shape).
  'http://explabs-project-serving-production-project-serving.default.svc.cluster.local:8080',
  'bf000000-0000-0000-0000-000000000001',
  'host_managed',
  '{"supports_streaming": true}'::jsonb
);

-- (a) A legitimate org-owned local variant (add-a-way / int-p3 shape):
-- org-namespaced slug unrelated to any endpoint, the customer's own wire id and
-- base_url, no matching `endpoints` row. Seeded host_managed on purpose so only
-- the endpoints linkage — not billing_source — can spare it.
insert into public.models (id, slug, display_name, category, owning_org_id)
values (
  'bf000000-0000-0000-0000-000000000022',
  'fold-scope-org__qwen3-max',
  'Qwen3 Max (self-hosted)',
  'owned',
  'bf000000-0000-0000-0000-000000000001'
);
insert into public.model_providers (
  id, model_id, provider, provider_model_id, base_url, owning_org_id,
  billing_source, capabilities
)
values (
  'bf000000-0000-0000-0000-000000000032',
  'bf000000-0000-0000-0000-000000000022',
  'local',
  'qwen3-max',
  'https://vllm.internal:8000/v1',
  'bf000000-0000-0000-0000-000000000001',
  'host_managed',
  '{"supports_streaming": true}'::jsonb
);

-- (a2) An adversarial legitimate variant whose provider_model_id coincidentally
-- equals the endpoint name, but whose slug does not. It must survive: a wire-id
-- coincidence alone is not the fold fingerprint (the endpoint's name must equal
-- the MODEL slug, in the same org).
insert into public.models (id, slug, display_name, category, owning_org_id)
values (
  'bf000000-0000-0000-0000-000000000023',
  'fold-scope-org__cs-router',
  'CS Router (self-hosted)',
  'owned',
  'bf000000-0000-0000-0000-000000000001'
);
insert into public.model_providers (
  id, model_id, provider, provider_model_id, base_url, owning_org_id,
  billing_source, capabilities
)
values (
  'bf000000-0000-0000-0000-000000000033',
  'bf000000-0000-0000-0000-000000000023',
  'local',
  'customer-support',
  'https://cs.internal:8000/v1',
  'bf000000-0000-0000-0000-000000000001',
  'host_managed',
  '{"supports_streaming": true}'::jsonb
);

-- (a3) A legitimate variant whose customer base_url merely CONTAINS the
-- substring "project-serving" (a plausible internal hostname) but has no
-- matching endpoints row. It must survive: the discriminator is the endpoints
-- projection, not a base_url substring heuristic (which would data-loss here).
insert into public.models (id, slug, display_name, category, owning_org_id)
values (
  'bf000000-0000-0000-0000-000000000024',
  'fold-scope-org__ml-router',
  'ML Router (self-hosted)',
  'owned',
  'bf000000-0000-0000-0000-000000000001'
);
insert into public.model_providers (
  id, model_id, provider, provider_model_id, base_url, owning_org_id,
  billing_source, capabilities
)
values (
  'bf000000-0000-0000-0000-000000000034',
  'bf000000-0000-0000-0000-000000000024',
  'local',
  'ml-router',
  'https://ml-project-serving.corp.internal:8000/v1',
  'bf000000-0000-0000-0000-000000000001',
  'host_managed',
  '{"supports_streaming": true}'::jsonb
);

-- Run the shipped migration against the seeded rows.
\ir ../../migrations/20260819180000_drop_legacy_folded_owned_models.sql

select is(
  (select count(*)::int from public.models
   where id = 'bf000000-0000-0000-0000-000000000021'),
  0,
  'the fold artifact model is deleted'
);

select is(
  (select count(*)::int from public.model_providers
   where id = 'bf000000-0000-0000-0000-000000000031'),
  0,
  'the fold artifact deployment cascades with its model'
);

select is(
  (select count(*)::int from public.models
   where id = 'bf000000-0000-0000-0000-000000000022'),
  1,
  'the legitimate org-owned local variant survives'
);

select is(
  (select count(*)::int from public.model_providers
   where id = 'bf000000-0000-0000-0000-000000000032'),
  1,
  'the legitimate variant deployment survives'
);

select is(
  (select count(*)::int from public.models
   where id = 'bf000000-0000-0000-0000-000000000023'),
  1,
  'a wire-id coincidence without a matching (org, slug) endpoint is spared'
);

select is(
  (select count(*)::int from public.model_providers
   where id = 'bf000000-0000-0000-0000-000000000033'),
  1,
  'the coincidence variant deployment survives'
);

select is(
  (select count(*)::int from public.models
   where id = 'bf000000-0000-0000-0000-000000000024'),
  1,
  'a customer base_url containing "project-serving" without an endpoint is spared'
);

select is(
  (select count(*)::int from public.model_providers
   where id = 'bf000000-0000-0000-0000-000000000034'),
  1,
  'the substring-coincidence variant deployment survives'
);

-- The endpoints row is history and must never be touched by this migration.
select is(
  (select count(*)::int from public.endpoints
   where id = 'bf000000-0000-0000-0000-000000000011'),
  1,
  'the Project-era endpoint (usage history) is left intact'
);

select * from finish();

rollback;
