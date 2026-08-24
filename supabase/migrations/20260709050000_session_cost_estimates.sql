-- Per-session cost estimates: promote token totals and the serve-cost
-- estimate from the opaque `usage` jsonb to typed columns on wm_sessions,
-- mirroring wm_rollouts. `cost_usd` is null when the serve model has no
-- verified list price — sessions report null rather than a $0 guess, the
-- same contract rollouts already follow.

alter table public.wm_sessions
  add column input_tokens bigint not null default 0 check (input_tokens >= 0),
  add column output_tokens bigint not null default 0 check (output_tokens >= 0),
  add column cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0);

comment on column public.wm_sessions.cost_usd is
  'Estimated serve spend in USD from verified list prices; null when the serve model has no verified price.';

-- Backfill from the persisted engine usage summaries. Tokens copy over
-- directly. Cost backfills only when the stored engine total is positive:
-- the engine tracker writes 0.0 for models missing from its price table, and
-- that sentinel must become null (unpriced) — a session with token traffic
-- on a priced model always has a positive cost.
update public.wm_sessions
   set input_tokens = coalesce((usage #>> '{total,input_tokens}')::bigint, 0),
       output_tokens = coalesce((usage #>> '{total,output_tokens}')::bigint, 0),
       cost_usd = case
         when coalesce((usage #>> '{total,cost_usd}')::numeric, 0) > 0
           then round((usage #>> '{total,cost_usd}')::numeric, 6)
         else null
       end
 where usage is not null;

-- record_wm_step gains the typed cost fields so they ride the same atomic
-- claim + insert transaction as the usage summary. The old signature must be
-- dropped explicitly: `create or replace` with a different parameter list
-- would create an overload instead of replacing the function.
drop function public.record_wm_step(uuid, integer, jsonb, jsonb, integer, jsonb);

create function public.record_wm_step(
  in_session_id uuid,
  in_step_index integer,
  in_action jsonb,
  in_observation jsonb,
  in_latency_ms integer default null,
  in_usage jsonb default null,
  in_input_tokens bigint default null,
  in_output_tokens bigint default null,
  in_cost_usd numeric default null
)
returns setof public.wm_steps
language sql
set search_path = ''
as $$
  with claimed as (
    update public.wm_sessions
       set step_count = in_step_index + 1,
           last_step_at = now(),
           usage = coalesce(in_usage, wm_sessions.usage),
           -- The typed totals travel with the usage summary: a step that
           -- carries a summary also carries the totals (a null in_cost_usd
           -- then means "unpriced serve model"), while a summary-less step
           -- leaves all four columns untouched. Token args left null beside
           -- a summary keep the row's accumulated counts — never reset to 0.
           input_tokens = case when in_usage is null then wm_sessions.input_tokens
                               else coalesce(in_input_tokens, wm_sessions.input_tokens) end,
           output_tokens = case when in_usage is null then wm_sessions.output_tokens
                                else coalesce(in_output_tokens, wm_sessions.output_tokens) end,
           cost_usd = case when in_usage is null then wm_sessions.cost_usd
                           else in_cost_usd end
     where wm_sessions.id = in_session_id
       and wm_sessions.step_count = in_step_index
       and wm_sessions.status = 'active'::public.wm_session_status
     returning wm_sessions.id
  )
  insert into public.wm_steps (wm_session_id, step_index, action, observation, latency_ms)
  select in_session_id, in_step_index, in_action, in_observation, in_latency_ms
    from claimed
  returning wm_steps.*;
$$;

-- Only the service role records steps; strip Supabase's default EXECUTE
-- grants (PUBLIC/anon/authenticated) like the other control-plane functions,
-- then restore the service-role grant the dropped signature carried — the
-- API records steps through the service-role client.
revoke all on function public.record_wm_step(
  uuid, integer, jsonb, jsonb, integer, jsonb, bigint, bigint, numeric
) from public, anon, authenticated;

grant execute on function public.record_wm_step(
  uuid, integer, jsonb, jsonb, integer, jsonb, bigint, bigint, numeric
) to service_role;
