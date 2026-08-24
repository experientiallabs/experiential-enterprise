import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { MAX_EMAIL_LENGTH, normalizeEmail } from "@/lib/email/address";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ userId: string }>;
};

// Change the account email through GoTrue's admin update. The admin asserts
// the change, so no confirmation email goes to the old or the new address
// (adminUserUpdate never touches the mailer); email_confirm keeps the account
// confirmed for sign-in and marks the email identity verified, matching how
// every account here is created (admin.createUser({ email_confirm: true })).
export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { userId } = await context.params;
  const email = await readEmail(request);
  if (email === null) {
    return NextResponse.json(
      { error: `A valid email address is required (at most ${MAX_EMAIL_LENGTH} characters).` },
      { status: 400 }
    );
  }
  const admin = createServiceRoleSupabaseClient();
  const { data: user, error: lookupError } = await admin.auth.admin.getUserById(userId);
  if (lookupError || !user?.user) {
    return NextResponse.json({ error: `User not found: ${userId}` }, { status: 404 });
  }
  const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true
  });
  if (updateError) {
    // GoTrue answers 422 when another account already holds the address and
    // 400 for an address its own validation refuses; both are caller errors,
    // not server failures.
    const status =
      updateError.status === 422 ? 409 : updateError.status === 400 ? 400 : 500;
    return NextResponse.json({ error: updateError.message }, { status });
  }
  return NextResponse.json({ userId, email });
}

/** The normalized email from the JSON body, or null when absent or malformed. */
async function readEmail(request: NextRequest): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const raw = (payload as { email?: unknown }).email;
  if (typeof raw !== "string") {
    return null;
  }
  return normalizeEmail(raw);
}

// Delete through GoTrue. The auth.users cleanup trigger removes every
// user-owned public row in the same database transaction, so an auth deletion
// cannot succeed while leaving stale memberships or per-user state behind.
export async function DELETE(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { userId } = await context.params;
  const actor = await requireAuthenticatedUser();
  if (actor.id === userId) {
    // Self-deletion would orphan the session mid-request and can strand the
    // deployment without any platform admin; another admin must do it.
    return NextResponse.json(
      { error: "You cannot delete your own account from the admin panel." },
      { status: 409 }
    );
  }

  const admin = createServiceRoleSupabaseClient();
  const { data: user, error: lookupError } = await admin.auth.admin.getUserById(userId);
  if (lookupError || !user?.user) {
    return NextResponse.json({ error: `User not found: ${userId}` }, { status: 404 });
  }
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
