-- Key display suffix: the last 4 characters of the plaintext secret, captured
-- at mint so key rows can render `xpl_ab12cd34…f2e1` instead of the prefix
-- alone. Secrets are stored hash-only, so a tail recorded at mint is the ONLY
-- way to ever show one. Nullable on purpose: keys minted before this column
-- existed never had their tail recorded, and those rows render prefix-only
-- rather than inventing data.
--
-- Disclosure math (standard last-4 practice): a customer secret is `xpl_` +
-- 40 hex chars (160 random bits). key_prefix (12 chars = 8 hex digits) plus
-- key_suffix (4 hex digits) reveal 16 of 44 chars, i.e. 12 of the 40 random
-- hex digits, leaving 28 hex digits (112 random bits) undisclosed - far
-- beyond brute force.
alter table public.api_keys
  add column key_suffix pg_catalog.text;

comment on column public.api_keys.key_suffix is
  'Last 4 chars of the plaintext secret, shown next to key_prefix for recognition (xpl_ab12cd34…f2e1). Null for keys minted before the column existed. Prefix + suffix disclose 12 of the 40 random hex digits; 112 bits stay hidden.';

-- Superadmin keys share the customer secret recipe (`xpladmin_` + 40 hex):
-- prefix (17 chars = 8 hex digits) plus 4-hex suffix likewise leave 112
-- random bits undisclosed.
alter table public.platform_admin_keys
  add column key_suffix pg_catalog.text;

comment on column public.platform_admin_keys.key_suffix is
  'Last 4 chars of the plaintext secret, shown next to key_prefix for recognition (xpladmin_ab12cd34…f2e1). Null for keys minted before the column existed. Prefix + suffix disclose 12 of the 40 random hex digits; 112 bits stay hidden.';
