import { NextResponse, type NextRequest } from "next/server";

import { expiryTimestamp, mintApiKeySecret, parseCreateApiKeyPayload } from "@/lib/api-keys/keys";
import { listOrgApiKeys } from "@/lib/api-keys/queries";
import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { jsonError, jsonOk } from "@/lib/http";
import { ensureOrgDefaultIdentity } from "@/lib/playground/serving-key";

export const dynamic = "force-dynamic";

// List the named organization's API keys — the same page the settings screen
// renders (name, prefix, created, last used, expires, revoked_at; never the
// hash, never a plaintext secret). Reading is member-level: the settings page
// shows every member the key list and gates only the mutations on admin, so
// this GET admits members where the sibling POST demands an admin.
//
// Contract 3: org API keys with management scope reach this list via
// gateway-api's _CUSTOMER_KEY_ROUTES allowlist (explabs/api/app.py).
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get("orgId");
    if (orgId === null || orgId.length === 0) {
      return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();
    const platformAdmin = await isPlatformAdmin();
    if (platformAdmin) {
      // Platform admins list keys in every org, memberless ones included; the
      // RLS select-all policy still 404s a genuinely absent org id.
      const { data: org, error: orgError } = await supabase
        .from("organizations")
        .select("id")
        .eq("id", orgId)
        .maybeSingle();
      if (orgError) {
        return NextResponse.json({ error: orgError.message }, { status: 500 });
      }
      if (!org) {
        return NextResponse.json({ error: "Organization not found." }, { status: 404 });
      }
    } else {
      // Resolve the org through the caller's RLS-scoped membership row:
      // another user's org is invisible there, so a guessed foreign id 404s
      // exactly like an absent one instead of leaking existence via 403.
      const { data: membership, error: membershipError } = await supabase
        .from("organization_members")
        .select("org_id")
        .eq("org_id", orgId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (membershipError) {
        return NextResponse.json({ error: membershipError.message }, { status: 500 });
      }
      if (!membership) {
        return NextResponse.json({ error: "Organization not found." }, { status: 404 });
      }
    }

    // Same client split as the settings page: api_keys rows are only
    // RLS-visible via membership, so a memberless platform admin reads
    // through the service role.
    const reader = platformAdmin ? createServiceRoleSupabaseClient() : supabase;
    const identityId = searchParams.get("identityId");
    const result = await listOrgApiKeys(reader, {
      orgId,
      page: Number.parseInt(searchParams.get("page") ?? "1", 10),
      showRevoked: searchParams.get("revoked") === "1",
      identityId: identityId !== null && identityId.length > 0 ? identityId : null
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}

// Mint an API key for the named organization. The plaintext secret appears
// exactly once, in this response; only its hash is stored.
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const payload = parseCreateApiKeyPayload(await request.json());

    const supabase = await createServerSupabaseClient();
    const platformAdmin = await isPlatformAdmin();
    if (platformAdmin) {
      // Platform admins manage keys in every org, memberless ones included
      // (the org page gate admits them the same way); the RLS select-all
      // policy still 404s a genuinely absent org id.
      const { data: org, error: orgError } = await supabase
        .from("organizations")
        .select("id")
        .eq("id", payload.orgId)
        .maybeSingle();
      if (orgError) {
        return NextResponse.json({ error: orgError.message }, { status: 500 });
      }
      if (!org) {
        return NextResponse.json({ error: "Organization not found." }, { status: 404 });
      }
    } else {
      // Resolve the org through the caller's RLS-scoped membership row:
      // another user's org is invisible there, so a guessed foreign id 404s
      // exactly like an absent one instead of leaking existence via 403.
      const { data: membership, error: membershipError } = await supabase
        .from("organization_members")
        .select("org_id")
        .eq("org_id", payload.orgId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (membershipError) {
        return NextResponse.json({ error: membershipError.message }, { status: 500 });
      }
      if (!membership) {
        return NextResponse.json({ error: "Organization not found." }, { status: 404 });
      }
      if (!(await isOrgAdmin(user.id, payload.orgId))) {
        return NextResponse.json(
          { error: "Only organization admins can manage API keys." },
          { status: 403 }
        );
      }
    }

    const admin = createServiceRoleSupabaseClient();
    // A banned org may not gain new serving credentials: the ban revoked every
    // live key, and this guard keeps the tenant dead until an operator unbans
    // it. Applies to platform admins too — unban first, then mint.
    const { data: orgBanRow, error: orgBanError } = await admin
      .from("organizations")
      .select("banned_at")
      .eq("id", payload.orgId)
      .maybeSingle();
    if (orgBanError) {
      return NextResponse.json({ error: orgBanError.message }, { status: 500 });
    }
    if (orgBanRow?.banned_at != null) {
      return NextResponse.json(
        { error: "This organization is banned. New API keys cannot be created." },
        { status: 403 }
      );
    }
    // Every key hangs off an identity (P-A reparent), so the column is set on
    // mint. An explicit identity must already exist and be active; an omitted
    // one resolves to the org's default identity, which is ensured here so the
    // org-level panel keeps minting successfully even for an org provisioned
    // after the identity-tier backfill.
    const identityResolution = await resolveMintIdentity(admin, payload.orgId, payload.identityId);
    if ("error" in identityResolution) {
      return NextResponse.json({ error: identityResolution.error }, { status: identityResolution.status });
    }
    const identityId = identityResolution.identityId;

    const minted = mintApiKeySecret();
    const { data: apiKey, error: insertError } = await admin
      .from("api_keys")
      .insert({
        org_id: payload.orgId,
        name: payload.name,
        key_prefix: minted.keyPrefix,
        key_suffix: minted.keySuffix,
        key_hash: minted.keyHash,
        created_by: user.id,
        identity_id: identityId,
        expires_at: expiryTimestamp(payload.expiresInDays)
      })
      .select(
        "id, org_id, name, key_prefix, key_suffix, created_at, last_used_at, revoked_at, expires_at, identity_id"
      )
      .single();
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    await recordAuditEvent(admin, {
      orgId: payload.orgId,
      actorKind: platformAdmin ? "platform_admin" : "user",
      actorId: user.id,
      action: "keys.mint",
      objectType: "api_key",
      objectId: apiKey.id,
      after: {
        name: apiKey.name,
        key_prefix: apiKey.key_prefix,
        identity_id: apiKey.identity_id,
        expires_at: apiKey.expires_at
      }
    });

    return jsonOk({ apiKey, secret: minted.secret });
  } catch (error) {
    return jsonError(error);
  }
}

type ServiceRoleClient = ReturnType<typeof createServiceRoleSupabaseClient>;

type MintIdentity = { identityId: string } | { error: string; status: number };

/**
 * Resolve the identity a minted key will hang off.
 *
 * An explicit identity must already exist under the org and be active. When no
 * identity is given, the key hangs off the org's default identity
 * (`org-{orgId}`); that row is ensured here (idempotent insert) so key
 * minting never fails on an org provisioned after the identity-tier backfill,
 * preserving the org-level API-keys panel's behavior.
 */
async function resolveMintIdentity(
  admin: ServiceRoleClient,
  orgId: string,
  requestedIdentityId: string | null
): Promise<MintIdentity> {
  if (requestedIdentityId !== null) {
    const { data: identity, error } = await admin
      .from("gateway_identities")
      .select("identity_id, active")
      .eq("org_id", orgId)
      .eq("identity_id", requestedIdentityId)
      .maybeSingle();
    if (error) {
      return { error: error.message, status: 500 };
    }
    if (!identity) {
      return { error: "Identity not found.", status: 404 };
    }
    if (identity.active === false) {
      return { error: "Cannot issue a key under a disabled identity.", status: 409 };
    }
    return { identityId: requestedIdentityId };
  }

  // Shared get-or-create of the org's default identity (same helper the
  // playground serving-key mint uses), so the two paths cannot diverge.
  try {
    return { identityId: await ensureOrgDefaultIdentity(admin, orgId) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), status: 500 };
  }
}
