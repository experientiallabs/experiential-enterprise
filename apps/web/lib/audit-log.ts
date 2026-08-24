// Types and query plumbing for the org audit-log viewer (Settings > Audit
// log). The events themselves are written by the web routes' service-role
// mutations (lib/audit.ts) and by the Python backend; this file models the
// backend's read API (explabs/api/routes/audit_log.py): one newest-first
// page per request, paged backwards through time with the `before` bound.

/** One audit event as the backend list API returns it. */
export type AuditLogEvent = {
  event_id: string;
  org_id: string | null;
  actor_kind: string;
  /** The acting user or api key id; null for unattributable system events. */
  actor_id: string | null;
  action: string;
  object_type: string;
  object_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  context: Record<string, unknown>;
  created_at: string;
};

/** One newest-first page of an organization's audit events. */
export type AuditLogList = {
  org_id: string;
  events: AuditLogEvent[];
};

export type AuditLogQuery = {
  action?: string | null;
  objectType?: string | null;
  /** ISO 8601 exclusive upper bound: pages backwards through time. */
  before?: string | null;
  limit?: number;
};

/** The backend's query-string names; `format=csv` is appended by the caller. */
export function auditLogQueryString(query: AuditLogQuery): string {
  const params = new URLSearchParams();
  if (query.action) {
    params.set("action", query.action);
  }
  if (query.objectType) {
    params.set("object_type", query.objectType);
  }
  if (query.before) {
    params.set("before", query.before);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

// The action vocabulary for the viewer's filter dropdown: the web app's own
// writes (lib/audit.ts call sites) merged with the backend's action registry
// (explabs/api/audit.py AuditAction). An action outside this list still
// renders in the table; it just is not offered as a preset filter.
export const AUDIT_ACTIONS: readonly string[] = [
  // Written by the web routes.
  "keys.mint",
  "keys.revoke",
  "keys.rotate",
  "members.role_set",
  "members.remove",
  "invites.create",
  "invites.revoke",
  "platform_admin.grant",
  "platform_admin.revoke",
  "billing.auto_recharge_set",
  "org.rename",
  "org.data_delete",
  // Written by the Python backend.
  "keys.limits_set",
  "aliases.create",
  "aliases.repoint",
  "aliases.rollback",
  "aliases.retire",
  "identities.create",
  "identities.update",
  "identities.disable",
  "grants.add",
  "grants.remove",
  "budgets.set",
  "budgets.delete",
  "org.training_cap_set",
  "billing.free_credit_caps_set",
  "billing.credit_grant",
  "byok.upsert",
  "byok.status_check",
  "byok.deployment_check",
  "byok.spend_refresh",
  "models.create",
  "models.provider_add",
  "models.waterfall_set",
  "projects.create",
  "projects.update",
  "projects.archive",
  "projects.setup_set",
  "projects.serving_settings_set",
  "jobs.preparation_enqueue",
  "jobs.enqueue",
  "jobs.cancel",
  "traces.upload",
  "traces.acquire",
  "traces.retry",
  "release_fault.set",
  "release_fault.release",
  "release_fault.clear",
  "usage.import",
  "yc.claim",
  "org_domains.create",
  "org_domains.verify",
  "org_domains.delete",
  "sso.provider_set",
  "sso.provider_delete",
  "sso.required_set",
  "teams.create",
  "teams.rename",
  "teams.delete",
  "teams.member_add",
  "teams.member_remove",
  "teams.key_assign",
  "provider_policy.set",
  "entitlements.grant",
  "entitlements.revoke",
  "provider_policy.delete"
];

// The union of both writers' object types (`organization` is the shared name
// for org-scoped settings; member/invite/user are web-only objects).
export const AUDIT_OBJECT_TYPES: readonly string[] = [
  "alias",
  "api_key",
  "budget",
  "credit_ledger_entry",
  "grant",
  "identity",
  "invite",
  "member",
  "org_domain",
  "organization",
  "project",
  "project_job",
  "project_setup",
  "provider_connection",
  "provider_policy",
  "entitlement",
  "release_fault",
  "sso_provider",
  "team",
  "trace_acquisition",
  "trace_source",
  "usage_import_batch",
  "user",
  "yc_claim"
];
