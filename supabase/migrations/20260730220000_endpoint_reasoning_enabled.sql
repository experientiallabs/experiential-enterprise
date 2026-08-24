-- Whether a model may use reasoning modes at all (the product owner, 2026-07-30: a
-- create-time checkbox). Reasoning-capable candidates (Azure GPT-5.x today)
-- accept pinned effort levels per candidate (endpoints.model_params); this
-- flag is the endpoint-wide switch above those pins: off means no pins can
-- be stored and the routing optimizer must not explore effort arms when it
-- learns to. Default true, matching every existing row's behavior.
alter table public.endpoints
  add column if not exists reasoning_enabled boolean not null default true;

comment on column public.endpoints.reasoning_enabled is
  'Whether reasoning modes are available to this endpoint: gates per-candidate reasoning_effort pins and (future) optimizer effort exploration. Create-time checkbox; editable in Config.';
