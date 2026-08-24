-- Drop the legacy-endpoint fold artifacts (gw-r2, punchlist E2). Earlier
-- catalog seeds promoted every ready Project-era serving endpoint into the
-- `models` catalog as an org-owned row with `category = 'owned'` and a single
-- `provider = 'local'`, `billing_source = 'host_managed'` deployment pointed at
-- the Project-serving origin. gw/catalog-data-r2 removed that fold from
-- seed-gateway-catalog.sql so fresh stacks never create the rows, but the
-- removal only stops new inserts: long-lived databases (staging, production,
-- and any preview seeded before the removal) still carry the folded rows, and
-- they surface on the models page under the storefront's "local" filter for a
-- member of the owning org (customer-support / terminal-use / coding).
--
-- Project serving is the only serving lane and those endpoints are
-- history-only, never catalog models (AGENTS.md product boundary), so this
-- deletes the stale catalog projections. It never touches the `endpoints`,
-- `wm_catalog_entries`, `default_models`, or `serving_requests` rows that keep
-- the Project-era usage history. The dependent `model_providers` and
-- `model_waterfalls` rows cascade with the deleted `models` row (ON DELETE
-- CASCADE). Idempotent: a no-op on a database that never carried the fold.
--
-- SCOPE — the exact fold fingerprint, NOT merely "any org-owned local model".
-- The fold (old pg_temp.fold_legacy_endpoints) minted, for each ready
-- `endpoints` row, a `models` row whose `slug` IS the endpoint name and a local
-- host_managed deployment whose `provider_model_id` is that same endpoint name,
-- pointed at the Project-serving origin. So a fold row is precisely a
-- projection of a still-present `endpoints` row: same org, and
-- `endpoints.name = models.slug = model_providers.provider_model_id`. That join
-- back to `endpoints` is the decisive discriminator and it is what this delete
-- keys on.
--
-- It must SPARE a legitimately-added org-owned local model (the "add a local
-- variant" / add-a-way flow, PR #471 / int-p3). That model shares the coarse
-- shape (category='owned', owning_org_id set, a local deployment) but is NOT a
-- fold projection: its slug is org-namespaced and unrelated to any endpoint
-- name, its deployment targets the customer's own base_url with the customer's
-- wire id (provider_model_id != slug), and the management API forces
-- billing_source='customer_managed' for it (host_managed is seed/ops-only). No
-- `endpoints` row shares its (org, slug), so the join below never matches it.
-- Endpoints are only ever removed by org-cascade (which also cascades the
-- model), so the linkage is reliable for every real fold row; a customer who
-- renamed a folded model's slug has adopted it and is likewise spared.
delete from public.models m
where m.category = 'owned'
  and m.owning_org_id is not null
  and exists (
    select 1
    from public.model_providers mp
    join public.endpoints e
      on e.org_id = m.owning_org_id
      and e.name = m.slug
      and e.name = mp.provider_model_id
    where mp.model_id = m.id
      and mp.provider = 'local'
      and mp.billing_source = 'host_managed'
  );
