-- Per-call routing audit on serving_requests (operator surface).
--
-- 20260723120000 recorded WHICH model served a call (`model`, `cluster_id`,
-- `cluster_label`) but not WHY. These four columns complete the wmh
-- RequestLogRecord contract so one call's decision is reconstructable end to
-- end: the reason the inference policy gave, the provider runtime id behind
-- the pool entry name, the policy's own inference cost, and which metered leg
-- the call belongs to. The serving path already computes all four per call and
-- was dropping them on the floor.
--
-- These are OPERATOR-AUDIT fields, not product fields, and that is the whole
-- reason they can exist alongside the opacity 20260723120000 describes. The
-- TELEMETRY reads keep saying only that an endpoint is "optimized":
-- `list_serving_requests` selects none of these columns, and the single-row
-- detail view is built from an ALLOWLIST of outcome columns, so a column added
-- to the row later is absent from the tenant payload by construction rather
-- than by someone remembering to deny it (asserted in
-- explabs/api/schemas_test.py). The audit read is a separate
-- platform-admin-only route, gated like the runs panel.
--
-- Telemetry, not every tenant read: the playground inspector
-- (GET /orgs/{org}/serving/requests/{id}/inspection, OrgRole.USER) already
-- serves the routed model ref and the cluster label as per-response evidence,
-- deliberately and with a product ruling pending. It reads `model` and
-- `cluster_label` off this table and nothing added here changes it.
--
-- No new index. The audit read fetches one row by primary key, and nothing
-- filters or groups on these columns, so an index would cost write throughput
-- on the highest-insert-rate table in the schema and buy nothing.

alter table public.serving_requests
  add column routing_reason text,
  add column provider_model text,
  -- Nullable for exactly one reason: the rows that already exist. The serving
  -- path always reports this figure (wmh types it as a plain float, 0 for the
  -- free hashing policy and real once a trained router serves), so a null here
  -- means "written before this column existed", not "the policy declined to
  -- say". A 0 is a measurement, and the check keeps the two distinguishable
  -- instead of backfilling a $0 guess over history.
  add column router_cost_usd numeric
    check (router_cost_usd is null or router_cost_usd >= 0),
  -- D-METERING's leg vocabulary, closed. Existing rows are all customer
  -- serving traffic, which is also what the serving path writes, so the
  -- default backfills them correctly.
  add column leg text not null default 'serving'
    check (leg in ('serving', 'optimization', 'eval', 'overhead'));

comment on column public.serving_requests.routing_reason is
  'Why the inference policy chose this model for this call. Operator audit only: no tenant read returns it, including the playground inspector, which names only the model and the cluster label.';

comment on column public.serving_requests.provider_model is
  'Provider runtime id behind the pool entry named in `model` (a Bedrock model id, an Azure deployment name). Server-internal, like every other provider resource id.';

comment on column public.serving_requests.router_cost_usd is
  'Inference cost of the routing decision itself, passed through from wmh, which always reports it. Null means the row predates this column; 0 is a real measurement (the free hashing policy). Operator audit only.';

comment on column public.serving_requests.leg is
  'D-METERING leg this call is metered under. Customer serving traffic is the default; the other legs cover platform work that runs through the same log.';
