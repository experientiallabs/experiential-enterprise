-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Org-level opt-in for capturing request/response CONTENT in telemetry.
--
-- The gateway usage ledger is content-free by design (see
-- 20260819190000_gateway_runtime.sql): request/response bodies are never
-- persisted, and the platform never even sees them — the gateway worker mounts
-- WMO's data plane, which owns the /v1 boundary and hands the platform only the
-- content-free attempt ledger. Capturing prompt/response content is therefore a
-- deliberate, per-organization opt-in that a tenant admin turns on, default OFF
-- (privacy-preserving): the metadata telemetry (tokens, cost, latency, outcome
-- reason) is always captured "without the data", and only this flag authorizes
-- also storing the message content once the runtime surfaces it on the
-- content-free ledger payload (the same activation gate as tool-name capture).
--
-- Additive, defaulted false, so every existing organization stays opted out.
-- Read by the telemetry settings surface and gated by the control API's admin
-- role check; no gateway invariant lives behind the column.
--
-- Migration prefix 20260821210000 is collision-free across the assembled train
-- union (append-only; no object dropped).

alter table public.organizations
  add column capture_prompt_content pg_catalog.bool not null default false;

comment on column public.organizations.capture_prompt_content is
  'Org opt-in to also capture request/response CONTENT in gateway telemetry (default false = metadata only, privacy-preserving). The content-free metadata stream is always on; this authorizes storing message content once the runtime surfaces it. Written by the admin-gated telemetry-settings control API.';
