-- Catalog logo key (gw-r2): the storefront shows a provider/family logo beside
-- every model. Rather than store binary assets or per-model URLs, the catalog
-- carries a small stable family key (e.g. 'anthropic', 'openai', 'google',
-- 'qwen', 'deepseek', 'moonshot', 'zai', 'xai', 'meta', 'mistral', ...) that
-- the web catalog maps to a simple-icons/local asset. Free-form text like
-- category: null means the UI falls back to a generic mark. Seeded for every
-- catalog row by seed-gateway-catalog.sql.
alter table public.models add column icon text;
