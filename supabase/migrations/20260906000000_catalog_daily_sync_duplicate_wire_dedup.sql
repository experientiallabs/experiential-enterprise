-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Fold the three duplicate identities the 2026-08-24 daily sync (#766) seeded
-- onto the curated models they duplicate, and take Fireworks' dated DeepSeek
-- lane off the undated base model.
--
-- The sync minted a SECOND public model for wire ids the seed already binds:
--   l3.3-euryale-70b            -> llama-3.3-euryale-70b  (openrouter sao10k/l3.3-euryale-70b)
--   llama-3.1-euryale-70b-v2.2  -> llama-3.1-euryale-70b   (openrouter sao10k/l3.1-euryale-70b)
--   omni-moderation-latest      -> omni-moderation         (openai omni-moderation-latest)
-- `model_providers_identity_key` is unique on
-- (model_id, provider, provider_model_id, owning_org_id, base_url), so a second
-- model_id makes the same wire id a legal second row: no conflict fires, no
-- constraint is violated, and the catalog simply lists the same model twice
-- (the euryale pair) or splits one model's `-latest` pointer off its base (omni
-- moderation). The seed no longer emits these rows and the alias map merges the
-- omni-moderation wires onto the base, so this only cleans databases already
-- seeded from #766.
--
-- Keys on the duplicate slug (stable text), so it is environment-independent
-- and idempotent: a fresh database seeded from this commit has no such rows and
-- the migration is a no-op, and a re-run finds nothing left to fold.
--
-- Step 5 fixes the same defect from an earlier seed: the undated
-- `deepseek-v4-flash` carried Fireworks' dated `-0731` registration, the wire
-- the `deepseek-v4-flash-0731` model serves.
--
-- Stale `gateway_aliases` rows of a deleted duplicate are deliberately left in
-- place, exactly as in 20260828250000/20260828280000: they hold no name a
-- current model needs and the refresher's own lifecycle governs activation.

create temporary table daily_sync_dedup_map (
  dup_slug text primary key,
  canonical_slug text not null
);
insert into daily_sync_dedup_map (dup_slug, canonical_slug) values
  ('l3.3-euryale-70b', 'llama-3.3-euryale-70b'),
  ('llama-3.1-euryale-70b-v2.2', 'llama-3.1-euryale-70b'),
  ('omni-moderation-latest', 'omni-moderation');

-- Every slug this migration rewrites; the closing assertion checks these and
-- only these.
create temporary table daily_sync_dedup_scope (slug text primary key);
insert into daily_sync_dedup_scope (slug)
select dup_slug from daily_sync_dedup_map
union
select canonical_slug from daily_sync_dedup_map
union
values ('deepseek-v4-flash'), ('deepseek-v4-flash-0731');

-- 1. Drop the duplicates' waterfall rungs: repointing a provider row to the
--    canonical model would otherwise violate the model_waterfalls composite FK
--    (model_id, model_provider_id). The canonical's default chain is rebuilt in
--    step 4. Org overrides are dropped with them rather than merged (unlike the
--    r3 dedups, which folded long-lived production models): these duplicates
--    are three days old, no org can have configured a chain on one, and every
--    route they carry survives on the canonical.
delete from public.model_waterfalls w
using public.models d, daily_sync_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null and w.model_id = d.id;

-- 2. Repoint the duplicate's routes onto the canonical, unless the canonical
--    already carries that exact route (the euryale wires) — the openai
--    `omni-moderation-latest` pointer moves onto `omni-moderation`, which is
--    where the seed now binds it.
update public.model_providers mp
set model_id = c.id
from public.models d, public.models c, daily_sync_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and c.slug = m.canonical_slug and c.owning_org_id is null
  and mp.model_id = d.id
  and d.id <> c.id
  and not exists (
    select 1 from public.model_providers x
    where x.model_id = c.id and x.provider = mp.provider
      and x.provider_model_id = mp.provider_model_id
      and x.owning_org_id is not distinct from mp.owning_org_id
      and x.base_url is not distinct from mp.base_url
  );

-- 3. Delete the routes that could not move (the canonical already held that
--    exact wire id) and then the emptied duplicate model rows. A duplicate is
--    never curated, so a preferred_rank or a surviving lane means something
--    else adopted the row and it is left alone.
delete from public.model_providers mp
using public.models d, daily_sync_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and mp.model_id = d.id
  and exists (
    select 1 from public.models c
    where c.slug = m.canonical_slug and c.owning_org_id is null
  );

delete from public.models d
using daily_sync_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and d.preferred_rank is null
  and not exists (select 1 from public.model_providers mp where mp.model_id = d.id);

-- 4. Rebuild a rung-0 default chain for any canonical left without one (its own
--    rung was dropped in step 1 only if it was itself listed as a duplicate;
--    this also covers a canonical whose chain never existed).
insert into public.model_waterfalls (model_id, position, model_provider_id)
select distinct on (c.id) c.id, 0, mp.id
from daily_sync_dedup_map m
join public.models c on c.slug = m.canonical_slug and c.owning_org_id is null
join public.model_providers mp on mp.model_id = c.id and mp.owning_org_id is null
where not exists (
  select 1 from public.model_waterfalls w
  where w.model_id = c.id and w.org_id is null and w.position = 0
)
order by c.id,
  (mp.status = 'active') desc,
  (mp.input_micro_usd_per_million is not null) desc,
  mp.id
on conflict (model_id, org_id, position) do nothing;

-- 5. Fireworks registers DeepSeek V4 Flash only as the dated `-0731` build,
--    which is its own catalog model; the undated base carried that same wire as
--    its rung-1 lane, so one wire id served two public models and a caller
--    asking for the rolling base could be handed the pinned build. Drop the
--    lane from the base (it keeps azure_openai at rung 0 and its own openrouter
--    wire); the dated model keeps the Fireworks wire. The seed no longer emits
--    the base's lane, but a seed re-run never deletes a provider row. Its rungs
--    (default and any org override) go with it through the composite FK's
--    cascade; the surviving rungs are then closed up so the chain stays 0..n.
delete from public.model_providers mp
using public.models m
where m.id = mp.model_id
  and m.slug = 'deepseek-v4-flash'
  and m.owning_org_id is null
  and mp.provider = 'fireworks'
  and mp.provider_model_id = 'accounts/fireworks/models/deepseek-v4-flash-0731';

-- Two phases: (model_id, org_id, position) is unique and not deferrable, so
-- lowering a rung onto a position a later rung still holds would abort. Park
-- the whole chain above every live position first, then land it at 0..n.
create temporary table deepseek_flash_rungs as
select w.id,
       pg_catalog.row_number() over (
         partition by w.model_id, w.org_id order by w.position
       ) - 1 as position
from public.model_waterfalls w
join public.models m on m.id = w.model_id
where m.slug = 'deepseek-v4-flash' and m.owning_org_id is null;

update public.model_waterfalls w
set position = w.position + 1000
from deepseek_flash_rungs r
where r.id = w.id and r.position <> w.position;

update public.model_waterfalls w
set position = r.position
from deepseek_flash_rungs r
where r.id = w.id and r.position <> w.position;

drop table deepseek_flash_rungs;

-- Fail loudly if a wire id this migration unbound is still on two public
-- models: leaving one behind reproduces the doubled catalog listing this fold
-- exists to remove. Scoped to the slugs it touched — an unrelated duplicate
-- elsewhere in a long-lived catalog is not this migration's business and must
-- not abort a release.
do $$
declare
  v_duplicated pg_catalog.int4;
  v_sample pg_catalog.text;
begin
  select pg_catalog.count(*), pg_catalog.min(duplicated.sample)
    into v_duplicated, v_sample
    from (
      select mp.provider || ':' || mp.provider_model_id || ' -> '
             || pg_catalog.string_agg(m.slug, ', ' order by m.slug) as sample
        from public.model_providers mp
        join public.models m on m.id = mp.model_id and m.owning_org_id is null
       where mp.owning_org_id is null
         and exists (
           select 1 from daily_sync_dedup_scope scope where scope.slug = m.slug
         )
       group by mp.provider, mp.provider_model_id, mp.base_url
      having pg_catalog.count(distinct mp.model_id) > 1
    ) duplicated;
  if v_duplicated > 0 then
    raise exception
      'daily-sync duplicate wire ids survived the fold: % (e.g. %)',
      v_duplicated, v_sample;
  end if;
end;
$$;

drop table daily_sync_dedup_map;
drop table daily_sync_dedup_scope;
