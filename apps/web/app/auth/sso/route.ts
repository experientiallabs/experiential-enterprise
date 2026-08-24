import { NextResponse, type NextRequest } from "next/server";

import { requestOrigin, safeNextPath } from "@/lib/auth/redirects";
import { createRouteSupabaseClient } from "@/lib/auth/server";
import { signinPath } from "@/lib/routes";

// Starts the SSO step-up dance for one org (?org=<slug>): the org's enabled
// provider + verified domain come from the authenticated-only definer RPC,
// then GoTrue's REAL signInWithSSO mints the IdP redirect. Until the GoTrue
// IdP-registration seam lands (explabs/api/routes/sso.py
// _sync_provider_to_gotrue), GoTrue answers that no provider matches the
// domain and this bounces back to /signin with sso_unavailable — a true
// statement of the deployment's state, never a faked flow.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const orgSlug = request.nextUrl.searchParams.get("org");
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  if (!orgSlug) {
    return NextResponse.redirect(loginErrorUrl(request, "sso_org_missing"), { status: 303 });
  }

  // The location is patched once GoTrue returns the IdP URL; the response
  // must exist first so the PKCE cookie writes land on it.
  const response = NextResponse.redirect(loginErrorUrl(request, "sso_unavailable"), {
    status: 303
  });
  const supabase = createRouteSupabaseClient(request, response);

  // Authenticated-only lookup: step-up means "signed in with the wrong
  // method", so the session exists; a signed-out visitor gets the neutral
  // copy on /signin with no button and cannot reach a descriptor here.
  const { data: descriptor, error: descriptorError } = await supabase.rpc(
    "org_sso_signin_provider",
    { in_slug: orgSlug }
  );
  const row = (descriptor as { provider_type?: unknown; domain?: unknown }[] | null)?.[0];
  if (descriptorError || typeof row?.domain !== "string") {
    return NextResponse.redirect(loginErrorUrl(request, "sso_unavailable"), { status: 303 });
  }

  const callbackUrl = new URL("/auth/callback", requestOrigin(request));
  callbackUrl.searchParams.set("next", next);
  const { data, error } = await supabase.auth.signInWithSSO({
    domain: row.domain,
    options: { redirectTo: callbackUrl.toString() }
  });
  if (error || !data?.url) {
    return NextResponse.redirect(loginErrorUrl(request, "sso_unavailable"), { status: 303 });
  }
  response.headers.set("location", data.url);
  return response;
}

function loginErrorUrl(request: NextRequest, code: string): URL {
  const url = new URL(signinPath(), requestOrigin(request));
  url.searchParams.set("error", code);
  return url;
}
