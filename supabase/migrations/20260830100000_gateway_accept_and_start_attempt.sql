-- Fold the money hot path's two pre-first-token round trips into one.
--
-- Today every request pays gateway_accept_request (persist accepted
-- authority) and then gateway_start_attempt (reserve money + persist the
-- attempt) as two sequential wire round trips before the first provider
-- byte. For a request with NO caller operation (no Idempotency-Key and no
-- client request id — the overwhelming hot path; server-generated
-- request_ids never collide), nothing observable happens between the two
-- writes, so the worker may defer the accept and commit both in ONE
-- security-definer call at reservation time.
--
-- This function is deliberately COMPOSITION, not duplication: it calls the
-- two existing functions inside its own transaction, so every money guard
-- and SQLSTATE of the CURRENT gateway_start_attempt (per-scope budgets,
-- promo cap + pre-verify allowance, price-unknown fail-closed, TPM/RPM,
-- spend gate) is inherited verbatim — including any FUTURE recomposition of
-- either inner function's BODY. The budget gate stays synchronous and
-- fail-closed: a rejection (P10xx) or a revoked key (42501) aborts the whole
-- call and rolls back BOTH writes, so no accepted-authority row ever exists
-- without its reservation outcome.
--
-- !!! MERGE-TRAIN FLAG — SIGNATURE COUPLING !!!
-- Because this fold forwards positionally into gateway_accept_request and
-- gateway_start_attempt, any migration that changes either inner function's
-- SIGNATURE (not body) must recompose this fold in the same migration, or a
-- fresh migrate-all breaks at this file's timestamp.
--
-- Keyed requests (caller_operation_sha256 IS NOT NULL) must keep the
-- two-call shape: their idempotency probe (P1020 conflict / P1021 replay
-- unavailable, advisory-lock serialization, dead-owner reclaim) is an
-- ACCEPT-time contract that surfaces outside the executor as a typed 409.
-- This function refuses them loudly rather than silently changing where
-- those errors surface; the worker adapter routes keyed requests down the
-- existing path.
--
-- Contract change (approved): accepted authority is now persisted at
-- reservation time (after route selection) rather than before it. A worker
-- crash between authorize and the first reservation leaves no ledger row
-- for a request that never dispatched — observability-only, zero money
-- impact, and strictly less for gateway_reconcile_crashed to reclaim. A
-- pre-dispatch failure (no rung reservable, route unavailable) still lands
-- in usage history: the worker's finish_request lazily persists
-- accept+finish in one transaction for a deferred request.

create or replace function public.gateway_accept_and_start_attempt(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_api_key_id pg_catalog.uuid,
  p_alias pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_api_surface pg_catalog.text,
  p_canonical_request_sha256 pg_catalog.text,
  p_deadline_at pg_catalog.timestamptz,
  p_attempt_ordinal pg_catalog.int4,
  p_route_depth pg_catalog.int4,
  p_deployment_id pg_catalog.text,
  p_provider pg_catalog.text,
  p_exact_model_id pg_catalog.text,
  p_pool_id pg_catalog.text,
  p_catalog_sha256 pg_catalog.text,
  p_billing_source pg_catalog.text,
  p_pricing_source pg_catalog.text,
  p_pricing_effective_at pg_catalog.timestamptz,
  p_input_rate_micro_usd pg_catalog.int8,
  p_cached_input_rate_micro_usd pg_catalog.int8,
  p_output_rate_micro_usd pg_catalog.int8,
  p_reasoning_rate_micro_usd pg_catalog.int8,
  p_maximum_cost_micro_usd pg_catalog.int8
)
returns table (attempt_id pg_catalog.text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Lock ordering. gateway_start_attempt serializes host-lane money decisions
  -- with FOR UPDATE on the organizations row, while the accept's insert takes
  -- a weaker KEY SHARE on that same row (the org_id foreign key). Folded into
  -- one transaction and raced against a sibling fold for the same org, that
  -- is a share-then-exclusive upgrade on both sides — a guaranteed deadlock
  -- pair. Take the reservation's exclusive lock FIRST, so concurrent folds
  -- queue in the same order the money gate already imposes. Customer-managed
  -- lanes reserve nothing and take no exclusive org lock, so they keep their
  -- lock-free concurrency.
  if p_billing_source = 'host_managed' then
    perform 1 from public.organizations orgs
     where orgs.id = p_org_id
     for update;
  end if;
  -- No p_caller_operation parameter exists on purpose: the fold is only
  -- sound when no caller-operation idempotency semantics are in play. The
  -- accept below always records a NULL caller operation, so its P1020/P1021
  -- branch is structurally unreachable here.
  perform public.gateway_accept_request(
    p_request_id,
    p_org_id,
    p_api_key_id,
    p_alias,
    p_alias_revision_id,
    p_api_surface,
    p_canonical_request_sha256,
    null,
    p_deadline_at
  );
  return query select s.attempt_id from public.gateway_start_attempt(
    p_request_id,
    p_org_id,
    p_attempt_ordinal,
    p_route_depth,
    p_deployment_id,
    p_provider,
    p_exact_model_id,
    p_pool_id,
    p_catalog_sha256,
    p_billing_source,
    p_pricing_source,
    p_pricing_effective_at,
    p_input_rate_micro_usd,
    p_cached_input_rate_micro_usd,
    p_output_rate_micro_usd,
    p_reasoning_rate_micro_usd,
    p_maximum_cost_micro_usd
  ) s;
end;
$$;

revoke all on function public.gateway_accept_and_start_attempt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int8, pg_catalog.int8,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.gateway_accept_and_start_attempt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int8, pg_catalog.int8,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8
) to service_role;
