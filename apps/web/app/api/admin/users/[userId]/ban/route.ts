import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { requireAuthenticatedUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ userId: string }>;
};

const MAX_REASON_LENGTH = 500;

// Ban an account. One definer RPC applies the whole ban atomically:
// auth.users.banned_until (GoTrue's enforcement column — it blocks every
// sign-in method and token refresh, and GoTrue reads it per request), the
// user_bans record (who/when/why), revocation of every API key the user
// minted (created_by scoped: never other members' keys) and of every
// superadmin key the account owns, and deletion of the user's GoTrue
// sessions. A failure rolls all of it back, so a locked-out
// user with live keys or an active account wearing a BANNED badge cannot
// exist even transiently (see docs/admin-user-bans.md).
export async function PUT(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [{ userId }, actor] = await Promise.all([context.params, requireAuthenticatedUser()]);
  if (actor.id === userId) {
    // Self-banning would sever the panel session mid-request and could strand
    // the deployment without any platform admin; another admin must do it.
    return NextResponse.json(
      { error: "You cannot ban your own account." },
      { status: 409 }
    );
  }
  const reason = await readReason(request);
  if (reason === null) {
    return NextResponse.json(
      { error: `A ban reason is required (at most ${MAX_REASON_LENGTH} characters).` },
      { status: 400 }
    );
  }
  const admin = createServiceRoleSupabaseClient();
  const { data: user, error: lookupError } = await admin.auth.admin.getUserById(userId);
  if (lookupError || !user?.user) {
    return NextResponse.json({ error: `User not found: ${userId}` }, { status: 404 });
  }
  const { error: banError } = await admin.rpc("record_user_ban", {
    in_user_id: userId,
    in_banned_by: actor.id,
    in_reason: reason
  });
  if (banError) {
    return NextResponse.json({ error: banError.message }, { status: 500 });
  }
  return NextResponse.json({ userId, banned: true });
}

// Unban restores sign-in only: one RPC clears banned_until and removes the
// record in the same transaction, so the roster and the lockout can never
// disagree. Idempotent — unbanning an account that is not banned is a no-op.
// Keys revoked at ban time STAY revoked (revocation is one-way everywhere in
// this schema); the user mints fresh ones after unban.
export async function DELETE(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { userId } = await context.params;
  const admin = createServiceRoleSupabaseClient();
  const { data: user, error: lookupError } = await admin.auth.admin.getUserById(userId);
  if (lookupError || !user?.user) {
    return NextResponse.json({ error: `User not found: ${userId}` }, { status: 404 });
  }
  const { error: unbanError } = await admin.rpc("clear_user_ban", { in_user_id: userId });
  if (unbanError) {
    return NextResponse.json({ error: unbanError.message }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}

/** The trimmed reason from the JSON body, or null when absent/blank/too long. */
async function readReason(request: NextRequest): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const raw = (payload as { reason?: unknown }).reason;
  if (typeof raw !== "string") {
    return null;
  }
  const reason = raw.trim();
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    return null;
  }
  return reason;
}
