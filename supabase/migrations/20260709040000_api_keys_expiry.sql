-- Experiential Labs world-model platform schema: API-key expiration.
--
-- An optional expiry set at mint time. NULL means the key never expires;
-- the backend stops honoring the key once `expires_at` passes, exactly like
-- a revocation the customer scheduled in advance.

alter table public.api_keys
  add column expires_at timestamptz;
