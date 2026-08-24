-- Capability-named defaults (the product owner, 2026-07-31): customers see what a model
-- or simulation IS FOR, never the benchmark it was measured on. Model slugs
-- become coding / customer-support / terminal-use and their simulations (the
-- importable catalog entries) become docker-env / customer-support /
-- terminal. Benchmark identity stays exactly where it is provenance: the
-- curation rows' `benchmark` column, report evidence copy, and the committed
-- corpus fixtures keep their benchmark names.
--
-- Renames converge EXISTING deployments in place; fresh stacks seed the new
-- names directly (supabase/seed.sql, explabs seed-models). Row identity (ids,
-- imports' catalog_entry_id pins, telemetry endpoint_id references) is
-- untouched.

-- The published defaults' curation rows, keyed by their fixed ids.
update public.default_models set
  slug = 'customer-support',
  title = 'customer-support',
  catalog_entry_name = 'customer-support'
where id = '00000000-0000-0000-0000-000000000d01';

update public.default_models set
  slug = 'terminal-use',
  title = 'terminal-use',
  catalog_entry_name = 'terminal'
where id = '00000000-0000-0000-0000-000000000d02';

update public.default_models set
  slug = 'coding',
  title = 'coding',
  catalog_entry_name = 'docker-env'
where id = '00000000-0000-0000-0000-000000000d03';

-- The default-models workspace's endpoints adopt their curation slugs. Only
-- rows still carrying the benchmark name move (an operator who already
-- renamed one keeps their name); per-org name uniqueness cannot collide
-- because the new names are the curation slugs nothing else in this org uses.
update public.endpoints set name = 'customer-support'
where org_id = '00000000-0000-0000-0000-000000000003' and name = 'tau-bench';

update public.endpoints set name = 'terminal-use'
where org_id = '00000000-0000-0000-0000-000000000003' and name = 'terminal-bench-2';

update public.endpoints set name = 'coding'
where org_id = '00000000-0000-0000-0000-000000000003' and name = 'swe-bench';

-- The demo-examples flagship is a model too; same rule, same rename.
update public.endpoints set name = 'customer-support'
where org_id = '00000000-0000-0000-0000-000000000002' and name = 'tau-bench';

-- Account workspaces seeded with the starter clone under its benchmark name:
-- the seeded shape only (declared clone slot, no simulation wired yet, not a
-- catalog reference), skipped when the org already holds a 'coding' model,
-- so a member's own creation is never renamed or collided with. Provisioning
-- then finds the row under its constant name and wires the simulation in.
update public.endpoints set name = 'coding'
where name = 'swe-bench'
  and is_catalog_default = false
  and world_model_id is null
  and org_id in (select org_id from public.account_workspaces)
  and not exists (
    select 1 from public.endpoints holder
    where holder.org_id = public.endpoints.org_id and holder.name = 'coding'
  );

-- Declared clones in every org pin the default's slug in their report
-- (cloned_from_default), and presence resolution joins that marker against
-- the curation slug; move the markers with the slugs or every existing
-- workspace clone loses its default identity.
update public.endpoints
set report = jsonb_set(report, '{cloned_from_default}',
  to_jsonb(case report->>'cloned_from_default'
    when 'tau-bench' then 'customer-support'
    when 'terminal-bench-2' then 'terminal-use'
    when 'swe-bench' then 'coding'
  end))
where report->>'cloned_from_default' in ('tau-bench', 'terminal-bench-2', 'swe-bench');

-- The shared catalog entries (the addable simulations). Imports pinned the
-- entry id, so existing imported world models are unaffected; only the
-- catalog card and future imports' default names change.
update public.wm_catalog_entries set name = 'customer-support'
where name = 'tau-bench';

update public.wm_catalog_entries set name = 'terminal'
where name = 'terminal-tasks';

update public.wm_catalog_entries set name = 'docker-env'
where name = 'swe-bench';
