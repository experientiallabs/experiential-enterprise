import { NextResponse, type NextRequest } from "next/server";

import { enabledOAuthProviders, isOAuthProvider } from "@/lib/auth/oauth-providers";
import { requestOrigin, safeNextPath } from "@/lib/auth/redirects";
import { createRouteSupabaseClient } from "@/lib/auth/server";
import { signinPath } from "@/lib/routes";

type Context = {
  params: Promise<{ provider: string }>;
};

// Starts the OAuth dance: GoTrue mints the provider authorize URL and the
// PKCE code-verifier cookie, then the browser is bounced to the provider.
// The provider redirects back through GoTrue to /auth/callback.
export async function GET(request: NextRequest, context: Context): Promise<NextResponse> {
  const { provider } = await context.params;
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  if (!isOAuthProvider(provider)) {
    return NextResponse.redirect(loginErrorUrl(request, "unknown_provider"), { status: 303 });
  }

  // A provider is "disabled" only when GoTrue's settings SAY it is disabled.
  // The old check fetched the authorize URL bare and read any non-3xx as
  // disabled, but that is a server-pod request with no apikey, and hosted
  // Supabase's edge answered it differently than a browser navigation, so
  // staging reported its fully configured Google/GitHub as disabled
  // (2026-07-30). The settings endpoint is an apikey'd JSON call, the same
  // class of request every other auth operation makes; when even that cannot
  // be read, proceed and let the browser's own navigation surface the error.
  const enabled = await enabledOAuthProviders();
  if (enabled !== null && !enabled.includes(provider)) {
    return NextResponse.redirect(loginErrorUrl(request, "provider_disabled"), { status: 303 });
  }

  // The location is patched once GoTrue returns the authorize URL; the
  // response must exist first so the PKCE cookie writes land on it.
  const response = NextResponse.redirect(loginErrorUrl(request, "oauth_failed"), { status: 303 });
  const supabase = createRouteSupabaseClient(request, response);
  const callbackUrl = new URL("/auth/callback", requestOrigin(request));
  callbackUrl.searchParams.set("next", next);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: callbackUrl.toString() }
  });
  if (error || !data?.url) {
    return NextResponse.redirect(loginErrorUrl(request, "oauth_failed"), { status: 303 });
  }
  response.headers.set("location", data.url);
  return response;
}

function loginErrorUrl(request: NextRequest, code: string): URL {
  const url = new URL(signinPath(), requestOrigin(request));
  url.searchParams.set("error", code);
  return url;
}
