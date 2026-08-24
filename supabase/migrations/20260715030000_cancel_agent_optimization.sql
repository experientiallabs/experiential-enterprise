-- Let members stop an optimizer run without rewriting a user-requested stop
-- as a worker failure. The API makes this state terminal immediately; the
-- worker observes it cooperatively and closes its E2B resources normally.
alter type public.agent_opt_run_status add value if not exists 'cancelled';
