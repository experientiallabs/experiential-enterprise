-- Hard shift to pi-node harnesses: every optimize run now executes the real vendored
-- pi agent in E2B sandboxes, and newly created agents seed pi-node HarnessDocs. Agents
-- created before this carry in-process (plain prompt) champion docs that the pi runtime
-- cannot execute — there is no compatibility path by decision, so they are removed
-- outright. Deletes cascade to their harness versions and optimization runs
-- (20260709200000_resource_delete_cascades); any storage objects staged by old runs are
-- reaped by the storage-cleanup outbox's normal operation or are inert orphans.
delete from public.agents;
