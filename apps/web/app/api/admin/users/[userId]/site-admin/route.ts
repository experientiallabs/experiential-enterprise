import { NextResponse, type NextRequest } from "next/server";

import { mintSuperadminKey, revokeSuperadminKeysForUser } from "@/lib/admin/superadmin-keys";
import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { requireAuthenticatedUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ userId: string }>;
};

// A fresh grant's response carries the plaintext key secret; even a shared
// cache must never hold it.
const NO_STORE = { "cache-control": "private, no-store" };

// Grant site-admin (platform operator) status. A FRESH grant is the only
// superadmin-key mint path: it mints one key for the NEW admin in the same
// action and returns the plaintext secret exactly once, to the granting
// operator (Admin > Access only lists and revokes). Idempotent on the grant:
// re-granting an existing operator succeeds without duplicating the row and
// without minting a duplicate key.
export async function PUT(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [{ userId }, actor] = await Promise.all([context.params, requireAuthenticatedUser()]);
  const admin = createServiceRoleSupabaseClient();
  const { data: user, error: lookupError } = await admin.auth.admin.getUserById(userId);
  if (lookupError || !user?.user) {
    return NextResponse.json({ error: `User not found: ${userId}` }, { status: 404 });
  }
  // A banned account must never gain operator authority: the grant would
  // mint a WORKING machine credential (superadmin keys authenticate outside
  // GoTrue, so banned_until never touches them).
  const { data: ban, error: banLookupError } = await admin
    .from("user_bans")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (banLookupError) {
    return NextResponse.json({ error: banLookupError.message }, { status: 500 });
  }
  if (ban !== null) {
    return NextResponse.json(
      { error: "This account is banned. Unban it before granting experiential-admin status." },
      { status: 409 }
    );
  }
  // ignoreDuplicates means ON CONFLICT DO NOTHING, so the select returns the
  // row only when this call actually created the grant.
  const { data: granted, error } = await admin
    .from("platform_admins")
    .upsert({ user_id: userId, granted_by: actor.id }, { onConflict: "user_id", ignoreDuplicates: true })
    .select("user_id");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if ((granted ?? []).length === 0) {
    // Already an operator: nothing changed, and no duplicate key is minted.
    return NextResponse.json({ userId, siteAdmin: true });
  }
  // Platform-scoped audit event: site-admin status belongs to no one org, and
  // it is recorded only when this call actually created the grant.
  await recordAuditEvent(admin, {
    orgId: null,
    actorKind: "platform_admin",
    actorId: actor.id,
    action: "platform_admin.grant",
    objectType: "user",
    objectId: userId
  });
  const ownerEmail = user.user.email ?? null;
  if (ownerEmail === null) {
    // owner_email is the audit trail that survives account deletion; never
    // mint an unattributable key. The grant itself stands.
    return NextResponse.json(
      {
        userId,
        siteAdmin: true,
        mintError: "The account has no email, so no superadmin key was minted."
      },
      { headers: NO_STORE }
    );
  }
  try {
    const minted = await mintSuperadminKey(
      `granted ${new Date().toISOString().slice(0, 10)}`,
      userId,
      ownerEmail
    );
    return NextResponse.json(
      { userId, siteAdmin: true, key: { name: minted.row.name, secret: minted.secret } },
      { headers: NO_STORE }
    );
  } catch (mintFailure) {
    // The grant is already applied; report the mint failure honestly instead
    // of masking it behind a 500 that would read as a failed grant.
    const message = mintFailure instanceof Error ? mintFailure.message : "unknown error";
    return NextResponse.json(
      {
        userId,
        siteAdmin: true,
        mintError: `The grant succeeded but no key was minted (${message}). Revoke and re-grant to mint one.`
      },
      { headers: NO_STORE }
    );
  }
}

// Revoke site-admin status AND every superadmin key the operator holds. The
// key revocation must be authoritative on the rows: relying on the
// platform_admins membership check at auth time alone would let a later
// re-grant REVIVE old keys nobody remembers. Keys are revoked BEFORE the
// membership row is deleted, so a partial failure leaves the account still
// an admin with dead keys and a retry completes the revoke; the reverse
// order would leave live key rows behind a deleted grant, unreachable by a
// retry (this route would 404). Operators cannot revoke themselves: the
// panel session would lose its gate mid-request, and the deployment could
// otherwise end up with no platform admin at all.
export async function DELETE(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [{ userId }, actor] = await Promise.all([context.params, requireAuthenticatedUser()]);
  if (actor.id === userId) {
    return NextResponse.json(
      { error: "You cannot revoke your own site-admin access." },
      { status: 409 }
    );
  }
  const admin = createServiceRoleSupabaseClient();
  const { data: grant, error: grantLookupError } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (grantLookupError) {
    return NextResponse.json({ error: grantLookupError.message }, { status: 500 });
  }
  if (grant === null) {
    return NextResponse.json({ error: "That account is not a site admin." }, { status: 404 });
  }
  try {
    await revokeSuperadminKeysForUser(userId);
  } catch (revokeFailure) {
    const message = revokeFailure instanceof Error ? revokeFailure.message : "unknown error";
    return NextResponse.json(
      { error: `Nothing was revoked (${message}). The account is still an admin; retry.` },
      { status: 500 }
    );
  }
  const { error } = await admin.from("platform_admins").delete().eq("user_id", userId);
  if (error) {
    // The keys are already dead; the membership row survived. A retry runs
    // the whole revoke again and completes it.
    return NextResponse.json(
      { error: `The keys were revoked but the admin row remains (${error.message}). Retry.` },
      { status: 500 }
    );
  }
  // Audit after both halves succeeded: keys dead AND the admin row removed.
  await recordAuditEvent(admin, {
    orgId: null,
    actorKind: "platform_admin",
    actorId: actor.id,
    action: "platform_admin.revoke",
    objectType: "user",
    objectId: userId
  });
  return new NextResponse(null, { status: 204 });
}
