import { NextResponse, type NextRequest } from "next/server";

import { mintApiKeySecret } from "@/lib/api-keys/keys";
import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ keyId: string }>;
};

// How long the outgoing key keeps authenticating after a rotation. The
// overlap window is the point: services roll to the new secret while the old
// one still works, so a rotation is never an outage.
const DEFAULT_OVERLAP_HOURS = 24;
const MIN_OVERLAP_HOURS = 1;
const MAX_OVERLAP_HOURS = 72;

// Rotate an API key: mint a replacement under the same org, identity, and
// name, then schedule the old key's expiry instead of revoking it outright.
// The replacement's plaintext secret appears exactly once, in this response
// (same contract as mint). Not transactional — a failure after the mint
// compensates by revoking the fresh key so no orphan secret stays live.
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const { keyId } = await context.params;

    const overlapHours = await parseOverlapHours(request);
    if (overlapHours === null) {
      return NextResponse.json({ error: "overlapHours must be a number." }, { status: 400 });
    }

    // Resolve the key through the caller's RLS-scoped client: another org's
    // key is invisible there, so a guessed foreign id 404s exactly like an
    // absent one instead of leaking existence via 403. Platform admins read
    // through the service role instead — api_keys rows are only RLS-visible
    // via membership, and admins manage keys in memberless orgs too.
    const platformAdmin = await isPlatformAdmin();
    const reader = platformAdmin
      ? createServiceRoleSupabaseClient()
      : await createServerSupabaseClient();
    const { data: oldKey, error: readError } = await reader
      .from("api_keys")
      .select("id, org_id, name, identity_id, revoked_at")
      .eq("id", keyId)
      .maybeSingle();
    if (readError) {
      return NextResponse.json({ error: readError.message }, { status: 500 });
    }
    if (!oldKey) {
      return NextResponse.json({ error: `API key not found: ${keyId}` }, { status: 404 });
    }
    if (!platformAdmin && !(await isOrgAdmin(user.id, oldKey.org_id))) {
      return NextResponse.json(
        { error: "Only organization admins can manage API keys." },
        { status: 403 }
      );
    }
    if (oldKey.revoked_at !== null) {
      return NextResponse.json(
        { error: "API key is already revoked; mint a new key instead of rotating." },
        { status: 409 }
      );
    }

    const admin = createServiceRoleSupabaseClient();
    const minted = mintApiKeySecret();
    const { data: apiKey, error: insertError } = await admin
      .from("api_keys")
      .insert({
        org_id: oldKey.org_id,
        name: oldKey.name,
        key_prefix: minted.keyPrefix,
        key_suffix: minted.keySuffix,
        key_hash: minted.keyHash,
        created_by: user.id,
        identity_id: oldKey.identity_id,
        expires_at: null
      })
      .select(
        "id, org_id, name, key_prefix, created_at, last_used_at, revoked_at, expires_at, identity_id"
      )
      .single();
    if (insertError || !apiKey) {
      return NextResponse.json(
        { error: insertError?.message ?? "Could not mint the replacement key." },
        { status: 500 }
      );
    }

    const oldKeyExpiresAt = new Date(Date.now() + overlapHours * 60 * 60 * 1000).toISOString();
    const { error: expireError } = await admin
      .from("api_keys")
      .update({ expires_at: oldKeyExpiresAt })
      .eq("id", keyId);
    if (expireError) {
      // Compensate: the replacement was minted but the old key never got its
      // expiry, so revoke the fresh key rather than leave two live secrets
      // with no rotation on record. A failing compensation is logged — the
      // 500 already tells the operator this rotation needs a manual look.
      const { error: compensationError } = await admin
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString(), revoked_by: user.id })
        .eq("id", apiKey.id);
      if (compensationError) {
        console.error(
          `key rotation compensation failed for replacement ${apiKey.id}: ${compensationError.message}`
        );
      }
      return NextResponse.json({ error: expireError.message }, { status: 500 });
    }

    await recordAuditEvent(admin, {
      orgId: oldKey.org_id,
      actorKind: platformAdmin ? "platform_admin" : "user",
      actorId: user.id,
      action: "keys.rotate",
      objectType: "api_key",
      objectId: keyId,
      after: { replacementKeyId: apiKey.id, oldKeyExpiresAt }
    });

    return jsonOk({ apiKey, secret: minted.secret, oldKeyExpiresAt });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * The overlap window from an optional JSON body: absent (or an absent field)
 * means the default, an out-of-range number clamps into [1, 72], and a
 * non-numeric value is the caller's bug — null tells the route to 400.
 */
async function parseOverlapHours(request: NextRequest): Promise<number | null> {
  const body = (await request.json().catch(() => null)) as { overlapHours?: unknown } | null;
  const value = body?.overlapHours;
  if (value === undefined || value === null) {
    return DEFAULT_OVERLAP_HOURS;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(MAX_OVERLAP_HOURS, Math.max(MIN_OVERLAP_HOURS, value));
}
