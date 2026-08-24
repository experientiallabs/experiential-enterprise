import { NextResponse, type NextRequest } from "next/server";

import { ACTIVE_ORG_COOKIE, findAuthorizedOrg } from "@/lib/active-org";

// A year: the cookie is a preference, not a credential; membership is
// re-checked on every resolution.
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Sets the workspace's active org (the org switcher's write path). */
export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const orgIdentifier =
    typeof body === "object" && body !== null && "org" in body && typeof body.org === "string"
      ? body.org
      : null;
  if (orgIdentifier === null) {
    return NextResponse.json({ error: "Body must be {\"org\": \"<slug or id>\"}." }, { status: 400 });
  }
  const org = await findAuthorizedOrg(orgIdentifier);
  if (org === null) {
    return NextResponse.json({ error: "Unknown organization." }, { status: 404 });
  }
  const response = NextResponse.json({ ok: true, org: org.slug });
  response.cookies.set(ACTIVE_ORG_COOKIE, org.slug, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS
  });
  return response;
}
