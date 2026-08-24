import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { requestOrigin } from "@/lib/auth/redirects";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { allowEmailSend } from "@/lib/auth/signup-rate-limit";
import { sendVerificationEmail } from "@/lib/auth/verification";

export const dynamic = "force-dynamic";

// Resends the "verify your email to use your credits" link for the SIGNED-IN
// user, driven by the overview banner. Authenticated-only (it acts on the
// caller's own session), neutral 200 so it reveals nothing, and rate-limited by
// the per-address cooldown so the banner can't be used to blast the mailbox.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthenticatedUser();
  if (user === null || user.email === null) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (allowEmailSend(user.email)) {
    try {
      const admin = createServiceRoleSupabaseClient();
      await sendVerificationEmail(admin, user.email, requestOrigin(request));
    } catch {
      // Neutral: a mailer/config hiccup still answers ok; the banner stays up
      // for unverified users, so they can retry.
    }
  }
  return NextResponse.json({ ok: true });
}
