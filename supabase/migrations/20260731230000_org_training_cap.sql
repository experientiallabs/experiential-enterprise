-- Per-organization ceiling for automatic training runs (the product owner, 2026-07-31:
-- the creation-time cap is a setting, not a constant). Null means the
-- platform default applies (DEFAULT_CREATE_TRAINING_CAP_USD, $100 today);
-- a value binds every automatic run this org's creations queue. The cap
-- gates the sweep's pre-spend projection, so it prevents a bill rather
-- than explaining one, and the org credit gate still applies first.

alter table public.organizations
  add column training_cap_usd numeric
    check (training_cap_usd is null or training_cap_usd > 0);

comment on column public.organizations.training_cap_usd is
  'Org-set USD ceiling for each automatic (creation-time) training run; null = platform default. Bound against the sweep''s pre-spend projection.';
