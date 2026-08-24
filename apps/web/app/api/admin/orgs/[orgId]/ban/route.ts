import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { requireAuthenticatedUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

const MAX_REASON_LENGTH = 500;

// Ban an organization. One definer RPC applies the whole ban atomically:
// organizations.banned_at (the enforcement column the mint/invite/join guards
// read), the org_bans record (who/when/why), revocation of EVERY live API key
// of the org (revocation is what stops /v1 serving), revocation of pending
// invites, and a sweep that bans every current member through the existing
// user-ban path — except platform operators and members already banned
// individually. A failure rolls all of it back (see docs/admin-user-bans.md).
export async function PUT(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [{ orgId }, actor] = await Promise.all([context.params, requireAuthenticatedUser()]);
  const reason = await readReason(request);
  if (reason === null) {
    return NextResponse.json(
      { error: `A ban reason is required (at most ${MAX_REASON_LENGTH} characters).` },
      { status: 400 }
    );
  }
  const admin = createServiceRoleSupabaseClient();
  const { data: org, error: lookupError } = await admin
    .from("organizations")
    .select("id")
    .eq("id", orgId)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }
  if (!org) {
    return NextResponse.json({ error: `Organization not found: ${orgId}` }, { status: 404 });
  }
  const { error: banError } = await admin.rpc("record_org_ban", {
    in_org_id: orgId,
    in_banned_by: actor.id,
    in_reason: reason
  });
  if (banError) {
    return NextResponse.json({ error: banError.message }, { status: 500 });
  }
  return NextResponse.json({ orgId, banned: true });
}

// Unban restores member sign-ins only: one RPC clears banned_at, removes the
// record, and unbans exactly the members the org ban swept (a member still
// belonging to another banned org stays banned under that org's ban;
// individually banned members are never touched). Idempotent. Keys and
// invites revoked at ban time STAY revoked (revocation is one-way everywhere
// in this schema); members mint fresh keys and admins re-invite after unban.
export async function DELETE(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { orgId } = await context.params;
  const admin = createServiceRoleSupabaseClient();
  const { data: org, error: lookupError } = await admin
    .from("organizations")
    .select("id")
    .eq("id", orgId)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }
  if (!org) {
    return NextResponse.json({ error: `Organization not found: ${orgId}` }, { status: 404 });
  }
  const { error: unbanError } = await admin.rpc("clear_org_ban", { in_org_id: orgId });
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
