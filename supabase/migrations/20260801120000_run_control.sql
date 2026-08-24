-- Run control (the product owner, 2026-08-01): simulation builds and model training runs
-- can be stopped and paused from the product, and a paused/stopped/stalled
-- run can be resumed - the job row keeps its identity, so the progress feed
-- continues streaming across the interruption.
--
-- `control` is the REQUEST channel: the API writes 'cancel' or 'pause', and
-- the worker honors it cooperatively at its next progress write, landing the
-- job in the matching terminal status and clearing the flag. Both job tables
-- share the build_job_status enum.

alter type build_job_status add value if not exists 'cancelled';
alter type build_job_status add value if not exists 'paused';

alter table public.build_jobs
  add column if not exists control text
  check (control in ('cancel', 'pause'));

alter table public.routing_optimize_jobs
  add column if not exists control text
  check (control in ('cancel', 'pause'));
