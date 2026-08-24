-- Cost controls: per-key TOKENS-per-minute limit (TPM), sibling to the
-- existing requests-per-minute knob on gateway_key_limits.
--
-- Why: requests_per_minute bounds dispatch frequency but not throughput. One
-- key streaming enormous completions consumes provider token quota and credit
-- at a rate RPM cannot see. tokens_per_minute is the standard provider-side
-- guardrail (OpenAI/Anthropic both meter TPM) and the docs pages already
-- promised "token limits" for this surface.
--
-- Semantics (enforced by gateway_start_attempt, recomposed in 20260822120000):
--   * Host lane only, exactly like RPM and the daily cap: BYOK dispatch is
--     never counted or blocked.
--   * Trailing observation, not reservation: token counts only exist after an
--     attempt settles, so the gate sums tokens of attempts whose terminal_at
--     falls in the last 60 seconds and refuses the NEXT dispatch once the
--     limit is met. A single request may therefore overshoot the limit; the
--     key is then throttled until the window drains. This matches provider
--     TPM behavior and needs no WMO contract change (no token estimate exists
--     at reserve time).
--   * All settled token kinds count (input + cached input + output +
--     reasoning): TPM meters total throughput, and cached/reasoning tokens
--     are still provider work.
--   * Explicit null = uncapped; no row = uncapped (there is NO default TPM,
--     unlike rpm 60 -- a token default would silently throttle today's
--     working traffic). The no-row default here and in gateway_start_attempt
--     MUST stay in lockstep with gateway_key_limits_effective below.

alter table public.gateway_key_limits
  add column tokens_per_minute pg_catalog.int4
    check (tokens_per_minute is null or tokens_per_minute > 0);

comment on table public.gateway_key_limits is
  'Per-key guardrails on the platform-funded lane only (BYOK traffic is never rate limited). Explicit null cap/rpm/tpm = uncapped. No row = rpm 60, no tpm, and a $50/day cap only while the org is free-credit funded.';

comment on column public.gateway_key_limits.tokens_per_minute is
  'Host-lane tokens-per-minute limit: total settled tokens (input + cached input + output + reasoning) across the key''s attempts with terminal_at in the trailing 60s. Trailing observation -- the breaching request lands, the next dispatch is refused (P1022). Null (or no row) = uncapped.';

-- ---------------------------------------------------------------------------
-- Effective-limits read seam gains the new column. Adding an OUT column
-- changes the result type, so this is a drop + create (CREATE OR REPLACE
-- would error), and the grants must be re-issued.

drop function public.gateway_key_limits_effective(pg_catalog.uuid);

-- Effective per-key guardrails: the explicit gateway_key_limits row when one
-- exists, otherwise the same defaults gateway_start_attempt enforces (rpm 60;
-- no tpm; a $50/day cap only while the org is free-credit funded). The no-row
-- default arms here and in gateway_start_attempt MUST stay in lockstep --
-- change both or neither.
create function public.gateway_key_limits_effective(in_api_key pg_catalog.uuid)
returns table (
  api_key_id pg_catalog.uuid,
  daily_spend_cap_micro_usd pg_catalog.int8,
  requests_per_minute pg_catalog.int4,
  tokens_per_minute pg_catalog.int4,
  source pg_catalog.text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org pg_catalog.uuid;
  v_limits public.gateway_key_limits%rowtype;
begin
  perform public.gateway_require_service_role();
  select keys.org_id into v_org
    from public.api_keys keys
   where keys.id = in_api_key;
  if v_org is null then
    raise exception using errcode = 'P0002',
      message = 'api key does not exist';
  end if;
  select limits.* into v_limits
    from public.gateway_key_limits limits
   where limits.api_key_id = in_api_key;
  if v_limits.api_key_id is not null then
    return query select in_api_key, v_limits.daily_spend_cap_micro_usd,
      v_limits.requests_per_minute, v_limits.tokens_per_minute,
      'explicit'::pg_catalog.text;
    return;
  end if;
  return query select in_api_key,
    case
      when public.gateway_org_free_credit_funded(v_org)
        then 50000000::pg_catalog.int8
      else null::pg_catalog.int8
    end,
    60, null::pg_catalog.int4, 'default'::pg_catalog.text;
end;
$$;

revoke all on function public.gateway_key_limits_effective(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.gateway_key_limits_effective(pg_catalog.uuid)
  to service_role;

comment on function public.gateway_key_limits_effective(pg_catalog.uuid) is
  'Effective per-key guardrails: the explicit row, else the enforcement defaults (rpm 60, no tpm, $50/day only while free-credit funded). Lockstep with gateway_start_attempt.';
