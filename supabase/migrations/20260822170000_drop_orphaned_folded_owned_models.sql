-- Drop the legacy-endpoint fold artifacts that 20260819180000 could not reach.
-- That migration deleted a folded catalog model only while it still joined back
-- to a live `endpoints` row (endpoints.name = models.slug = provider_model_id).
-- On production the customer-support / terminal-use / coding demo models are
-- still on the models page (the product owner, 2026-08-21): their backing `endpoints` rows
-- were removed after that migration ran, so the join no longer matches and the
-- orphaned `models` projections survived. Project serving is not a serving lane
-- and these are history-only, never catalog models (AGENTS.md product
-- boundary), so this removes the stale projections.
--
-- SCOPE — the fold fingerprint WITHOUT the (now-unreliable) endpoints join,
-- using the fold's OWN invariant instead. The fold minted, per ready endpoint,
-- an org-owned `models` row (`category = 'owned'`, `owning_org_id` set) whose
-- slug IS the endpoint name, plus a single `provider = 'local'`,
-- `billing_source = 'host_managed'` deployment whose `provider_model_id` is that
-- SAME endpoint name, pointed at the Project-serving origin. So a fold row
-- always has `model_providers.provider_model_id = models.slug`. That equality is
-- the decisive, endpoints-independent discriminator: a legitimately-added local
-- variant ("add a local variant" / add-a-way, PR #471) carries an
-- org-namespaced slug and the customer's own wire id, so its
-- `provider_model_id != slug` and it is spared even in the adversarial
-- `host_managed` case the earlier migration's test guards. A public provider
-- model (Fireworks / Bedrock / Azure Foundry) is never `local` and never
-- `owned`, so it can never match.
--
-- The dependent `model_providers` and `model_waterfalls` rows cascade with the
-- deleted `models` row. It never touches `endpoints`, `wm_catalog_entries`,
-- `default_models`, or `serving_requests` (Project-era usage history).
-- Idempotent: a no-op on a database that never carried the fold, and on one the
-- earlier migration already fully cleaned.
delete from public.models m
where m.category = 'owned'
  and m.owning_org_id is not null
  and exists (
    select 1
    from public.model_providers mp
    where mp.model_id = m.id
      and mp.provider = 'local'
      and mp.billing_source = 'host_managed'
      and mp.provider_model_id = m.slug
  );
