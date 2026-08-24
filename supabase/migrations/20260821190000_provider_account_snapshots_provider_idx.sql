-- Additive index for the "latest reading per (org, provider)" read.
--
-- The web loaders behind the Credits page, the Settings > Providers panel, and
-- the Overview credit-accounts sparklines fetch the newest snapshot for each
-- connected provider one provider at a time:
--
--   select ... from provider_account_snapshots
--   where org_id = $1 and provider = $2 [and source <> 'self_reported']
--   order by taken_at desc limit 1;
--
-- The existing (org_id, taken_at desc) index has no provider column, so that
-- query walks an org's snapshots newest-first and discards the ones for other
-- providers until it hits the target — which grows unbounded as spend-refresh
-- rows accumulate (the refresh endpoint is "cheap-safe to call quite often").
-- This composite makes each per-provider lookup a direct index seek plus the
-- LIMIT 1, independent of how busy any one provider's history is.
create index provider_account_snapshots_org_provider_taken_idx
  on public.provider_account_snapshots (org_id, provider, taken_at desc);
