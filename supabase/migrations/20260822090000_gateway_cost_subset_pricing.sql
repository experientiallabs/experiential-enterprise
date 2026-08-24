-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Fix gateway_attempt_cost_micro_usd to price cached/reasoning tokens as the
-- SUBSETS they are, instead of double-charging or refusing to price at all.
--
-- WMO's usage contract (wmo.common.models.Usage, mirrored by the gateway's
-- GatewayUsage) is explicit: cache-read counts are subsets of ``input_tokens``
-- and reasoning counts are subsets of ``output_tokens`` — "they never replace
-- the total ... and must not be added a second time by callers." The original
-- formula (20260819190000_gateway_runtime.sql) added them a second time:
--
--   input * input_rate + cached * cached_rate + output * output_rate + ...
--
-- so a cache hit was billed once at the FULL input rate inside input_tokens and
-- again at the cached rate — a strict overcharge on every deployment that
-- declares a cached rate. Worse, the null guard treated a reported-but-unrated
-- token kind as "price unknown": a provider reporting cached or reasoning
-- tokens on a route without that rate made the whole cost NULL, which settles
-- host-managed traffic at $0 (gateway_settle_attempt coalesces a null cost to
-- zero) and pushes pass-through estimates back to the reservation guess.
--
-- New semantics, matching the platform's other pricer (explabs/
-- usage_import_catalog.price_usage):
--   * cached input tokens price at the cached rate, FALLING BACK to the input
--     rate when no cached discount is declared; the fresh remainder
--     (input - cached) prices at the input rate.
--   * reasoning tokens price at the reasoning rate, FALLING BACK to the output
--     rate (OpenAI-style usage already counts reasoning inside output_tokens);
--     the remainder (output - reasoning) prices at the output rate.
--   * cost is NULL only when tokens exist whose EFFECTIVE rate is unknown —
--     i.e. the base input/output rate for that direction is null — which is
--     exactly the pricing_known signal finalize already derives from the
--     frozen base rates (20260821220000). No event that reads pricing_known =
--     true can settle to an unpriced NULL cost anymore.
--   * subset counts are clamped to their totals (least/greatest) so a
--     malformed provider report can inflate neither term.
--
-- Same signature, so CREATE OR REPLACE suffices; last definition wins.
-- Callers (gateway_settle_attempt) are unchanged. Migration prefix
-- 20260822090000 is collision-free across the assembled train union.

create or replace function public.gateway_attempt_cost_micro_usd(
  p_input_tokens pg_catalog.int4,
  p_cached_input_tokens pg_catalog.int4,
  p_output_tokens pg_catalog.int4,
  p_reasoning_tokens pg_catalog.int4,
  p_input_rate pg_catalog.int8,
  p_cached_input_rate pg_catalog.int8,
  p_output_rate pg_catalog.int8,
  p_reasoning_rate pg_catalog.int8
)
returns pg_catalog.int8
language sql
immutable
security definer
set search_path = ''
as $$
  with counts as (
    select
      -- Subset counts clamped into their totals; fresh = the remainder.
      least(
        coalesce(p_cached_input_tokens, 0), coalesce(p_input_tokens, 0)
      )::pg_catalog.int8 as cached_tokens,
      greatest(
        coalesce(p_input_tokens, 0)
          - least(
              coalesce(p_cached_input_tokens, 0), coalesce(p_input_tokens, 0)
            ),
        0
      )::pg_catalog.int8 as fresh_input_tokens,
      least(
        coalesce(p_reasoning_tokens, 0), coalesce(p_output_tokens, 0)
      )::pg_catalog.int8 as reasoning_tokens,
      greatest(
        coalesce(p_output_tokens, 0)
          - least(
              coalesce(p_reasoning_tokens, 0), coalesce(p_output_tokens, 0)
            ),
        0
      )::pg_catalog.int8 as fresh_output_tokens,
      coalesce(p_cached_input_rate, p_input_rate) as effective_cached_rate,
      coalesce(p_reasoning_rate, p_output_rate) as effective_reasoning_rate
  )
  select case
    when p_input_tokens is null and p_output_tokens is null then null
    when (counts.fresh_input_tokens > 0 and p_input_rate is null)
      or (counts.cached_tokens > 0 and counts.effective_cached_rate is null)
      or (counts.fresh_output_tokens > 0 and p_output_rate is null)
      or (counts.reasoning_tokens > 0 and counts.effective_reasoning_rate is null)
      then null
    else (
      counts.fresh_input_tokens * coalesce(p_input_rate, 0)
      + counts.cached_tokens * coalesce(counts.effective_cached_rate, 0)
      + counts.fresh_output_tokens * coalesce(p_output_rate, 0)
      + counts.reasoning_tokens * coalesce(counts.effective_reasoning_rate, 0)
      + 500000
    ) / 1000000
  end
  from counts;
$$;

revoke all on function public.gateway_attempt_cost_micro_usd(
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.int4,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8, pg_catalog.int8
) from public, anon, authenticated, service_role;
