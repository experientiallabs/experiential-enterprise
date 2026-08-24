-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Provenance for locally produced assets (D-LOCAL-PUSH, 2026-07-30): a world
-- model or endpoint that arrived through the CLI push surface should say so in
-- the product, so an operator can tell "measured on my machine and uploaded"
-- from "built by the platform pipeline". NULL means platform-made; the column
-- is plain text so future origins land without a migration.

alter table public.world_models
  add column if not exists origin text;
comment on column public.world_models.origin is
  'How the current artifact arrived: ''local-push'' for a CLI bundle push; NULL for a platform build.';

alter table public.endpoints
  add column if not exists origin text;
comment on column public.endpoints.origin is
  'How the endpoint''s evidence arrived: ''local-push'' when a customer API key created it or installed its artifacts; NULL for platform-made.';
