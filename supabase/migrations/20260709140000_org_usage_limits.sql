-- Per-organization usage budget: the maximum priced spend (USD) an org may
-- accumulate across serving sessions, playground rollouts, and builds before
-- the backend refuses further spend. Null means unlimited. The default
-- applies only to organizations created from now on (self-signup personal
-- orgs, tenant-provisioning invites, and admin-created tenants); existing
-- organizations are grandfathered as unlimited, and platform admins bypass
-- the budget entirely at enforcement time.

alter table public.organizations
  add column usage_limit_usd numeric(12, 2)
    check (usage_limit_usd is null or usage_limit_usd >= 0);

alter table public.organizations
  alter column usage_limit_usd set default 20;

comment on column public.organizations.usage_limit_usd is
  'Maximum priced spend in USD across the org''s sessions, rollouts, and builds; null = unlimited. New organizations default to $20; platform admins may change it from the admin panel.';
