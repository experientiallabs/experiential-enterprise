// Server-only audit trail for the web app's direct service-role mutations.
// Everything the Python backend mutates is audited backend-side; these
// helpers cover the mutations the Next.js routes perform themselves (key
// lifecycle, membership, invites, platform-admin grants, org settings) by
// calling the `record_audit_event` definer RPC (service-role execute only).

import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditActorKind = "user" | "platform_admin" | "system";

export type AuditEvent = {
  /** Null only for platform-scoped events (platform-admin grant/revoke). */
  orgId: string | null;
  actorKind: AuditActorKind;
  /** The acting user id; null for unattributable system events. */
  actorId: string | null;
  /** Dotted verb, e.g. "keys.mint", "members.role_set". */
  action: string;
  objectType: string;
  objectId: string;
  before?: unknown;
  after?: unknown;
  context?: Record<string, unknown>;
};

// Key names whose values must never reach the audit trail. Substring match on
// the lowercased key so `apiKeySecret`, `access_token`, `key_hash`, and
// `stripe_credential_id` are all caught without enumerating every spelling.
const SECRET_KEY_FRAGMENTS = ["secret", "token", "credential", "password", "key_hash", "keyhash"];

function isSecretKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/**
 * Strip secret-named keys from an audit snapshot before it is persisted.
 * Recurses through plain objects and arrays; anything else passes through
 * untouched (snapshots are JSON-shaped by construction).
 */
export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactAuditValue(entry));
  }
  if (typeof value === "object" && value !== null) {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSecretKey(key)) {
        continue;
      }
      redacted[key] = redactAuditValue(entry);
    }
    return redacted;
  }
  return value;
}

/**
 * Record one audit event through the service-role client. NEVER throws: an
 * audit-trail failure must not fail the customer mutation it describes
 * (pre-launch decision — the mutation has already committed by the time this
 * runs, so surfacing the failure would report success as an error). Failures
 * are logged for the operator instead.
 */
export async function recordAuditEvent(admin: SupabaseClient, evt: AuditEvent): Promise<void> {
  try {
    const { error } = await admin.rpc("record_audit_event", {
      p_org_id: evt.orgId,
      p_actor_kind: evt.actorKind,
      p_actor_id: evt.actorId,
      p_action: evt.action,
      p_object_type: evt.objectType,
      p_object_id: evt.objectId,
      p_before: evt.before === undefined ? null : redactAuditValue(evt.before),
      p_after: evt.after === undefined ? null : redactAuditValue(evt.after),
      p_context: evt.context ?? null
    });
    if (error) {
      console.error(`audit event ${evt.action} on ${evt.objectType}/${evt.objectId} failed: ${error.message}`);
    }
  } catch (error) {
    console.error(
      `audit event ${evt.action} on ${evt.objectType}/${evt.objectId} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
