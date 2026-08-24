-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Reconcile gateway alias identities with the deduped catalog (P0: production
-- deploy 32608519834).
--
-- The catalog dedups (20260828250000 and 20260828270000) renamed models IN
-- PLACE — deliberately keeping each model's uuid so routes, waterfalls, and
-- usage history stayed attached. But the gateway's alias identity rows pin
-- alias_id ('model-<uuid>', the id existing callers hold) to alias_name (the
-- model's slug at first activation), and gateway_activate_alias_revision's
-- identity guard REFUSES an alias_id presenting a new name:
--
--   alias identity drifted: alias_id is bound to another name or organization
--
-- On production that made every catalog refresh fail after the dedups (131
-- drifted rows: the 250000 adoptions plus the 270000 maker-dated renames), so
-- the worker kept serving the pre-refresh state and the deploy's transactional
-- smoke rolled the revision back.
--
-- The rename here IS an identity-preserving maker-level rename, so the correct
-- reconciliation matches the guard's contract from the data side: update the
-- alias row's NAME in place, keeping alias_id (callers pinned to the id keep
-- resolving), the org binding, the active flag, and the whole revision history
-- (revisions hang off alias_id). Named aliases (origin = 'named') are operator
-- property and are never touched. A rename is skipped only if another row
-- already holds the target (name, org) namespace — none does today — and any
-- REMAINING drift fails this migration loudly, because leftover drift would
-- reproduce the refresh outage at the next deploy's smoke instead.
--
-- Stale alias rows of models the dedups DELETED are deliberately kept: they
-- hold no name a current model needs, they preserve rollback history, and the
-- refresher's own lifecycle governs their activation.
--
-- Idempotent (drift-defined WHERE; re-run is a no-op) and a no-op on fresh
-- databases (no aliases yet). Forward path note: the runtime sync and the
-- daily-sync agent never rename models (a judgment-merge attaches lanes to the
-- surviving canonical, whose uuid and slug are stable), so identities cannot
-- drift from the pipeline — only a slug-renaming MIGRATION can, and any future
-- one must ship this same reconcile alongside it.

update public.gateway_aliases a
set alias_name = m.slug
from public.models m
where a.alias_id = 'model-' || m.id
  and a.origin <> 'named'
  and a.org_id is not distinct from m.owning_org_id
  and a.alias_name <> m.slug
  and not exists (
    select 1 from public.gateway_aliases held
    where held.alias_name = m.slug
      and held.org_id is not distinct from a.org_id
      and held.alias_id <> a.alias_id
  );

-- Fail loudly if any catalog alias identity still drifts from its model: the
-- refresh outage would otherwise silently return on the next deploy.
do $$
declare
  v_drifted pg_catalog.int4;
  v_sample pg_catalog.text;
begin
  select pg_catalog.count(*),
         pg_catalog.min(a.alias_id || ': ' || a.alias_name || ' -> ' || m.slug)
    into v_drifted, v_sample
    from public.gateway_aliases a
    join public.models m on a.alias_id = 'model-' || m.id
   where a.origin <> 'named'
     and a.org_id is not distinct from m.owning_org_id
     and a.alias_name <> m.slug;
  if v_drifted > 0 then
    raise exception
      'catalog alias identities still drifted after reconcile: % rows (e.g. %) — a name is held by another alias in the same namespace',
      v_drifted, v_sample;
  end if;
end;
$$;
