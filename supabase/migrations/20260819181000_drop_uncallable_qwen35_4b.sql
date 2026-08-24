-- Drop the uncallable qwen3.5-4b public catalog row (gw-r2, punchlist E2
-- follow-up; per-model listing verifier core-P19). qwen3.5-4b was pinned as a
-- preferred model but never had a deployment: it is not on OpenRouter (the
-- house lane's only live connection), the repo only serves it through Tinker
-- for training, and the operator's self-hosted proxy address is not final.
-- A public row with zero deployments is "listed but not callable" - a
-- customer can select it and it can never return anything, which violates
-- the catalog invariant that a listed public model is routable.
--
-- seed-gateway-catalog.sql no longer creates the row, so fresh stacks are
-- clean; this deletes it from long-lived databases (staging, production, and
-- previews seeded before the removal). Scope is exactly the dead row: the
-- public (owning_org_id null) qwen3.5-4b with no deployment. An org that later
-- adds its own routable qwen3.5-4b (owned row, or a deployment on this slug)
-- is untouched. Idempotent: a no-op once the row is gone or was never seeded.
delete from public.models m
where m.slug = 'qwen3.5-4b'
  and m.owning_org_id is null
  and not exists (
    select 1 from public.model_providers mp where mp.model_id = m.id
  );
