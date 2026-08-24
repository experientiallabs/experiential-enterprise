import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { loadSupabaseAuthSettings } from "./lib/auth/config";
import { hasSupabaseAuthCookie } from "./lib/auth/cookies";
import { safeNextPath } from "./lib/auth/redirects";
import {
  creditsPath,
  docsPath,
  insightsPath,
  logsPath,
  modelsPath,
  securityPath,
  signinPath,
  signupPath,
  ycPath
} from "./lib/routes";

// DESIGN: this proxy is a PUBLIC ALLOWLIST (isPublicPath) — a fixed set of
// public paths, everything else gated. A public-by-default variant (a private
// allowlist / privateRuleFor) was built on the shell branch and DELIBERATELY
// DROPPED before launch: (1) it re-conflicted on every merge as other lanes
// extended isPublicPath (a persistent merge treadmill), and (2) its /api/*
// handling missed the /api/models/<slug> catalog exemption, which would have
// 401'd the public model page's UseViaKeyCard read — a real catalog regression.
// This allowlist delivers the same product contract ("pages public, actions
// gate") without either problem. Do not "simplify" it back to public-by-default.

// /login and /signup are not real paths: next.config permanent
// redirects send them to /signin (query preserved) before this proxy runs.
// /models is the unauthenticated door: it serves the published default
// models signed-out, and /models/<slug> is the shared per-model detail URL for both audiences
// (the layout/page branch on the session; a signed-out visitor gets a default model's public
// detail or a sign-in bounce). next.config owns all retired /simulations redirects.
// "/" resolves per audience (HomePage redirects
// signed-out visitors to /models, members to their workspace), so it must reach the app rather
// than bounce signed-out visitors to sign-in.
// The /docs tree and /llms.txt are public API documentation (the product owner,
// 2026-07-30): integration references must be readable, linkable, and
// scrapeable without a session. /docs is a PREFIX — every docs page
// (quickstart, core loop, errors, ...) renders signed-out; the admin-only
// /docs/internal page enforces its own 404 gate in the route, not here.
// /credits is public per the gating contract (design-system "Gating
// patterns"): the page renders empty-state numbers signed-out and gates only
// its actions; the org-scoped API routes it calls all stay session-gated.
// /logs and /insights are signed-out storefront surfaces: /logs (formerly
// /telemetry) renders the full usage surface over deterministic DEMO data, and
// /insights renders a locked teaser (<InsightsLocked/>) — both branch on the
// session in their page.tsx and return the signed-out view BEFORE resolving an
// org or building a data source, so no real tenant read happens without a
// session. Both are linked from PublicSidebar, so gating them here would bounce
// the link to /signin. Exact paths: filters/queries ride the query string, so
// each is the whole surface and nothing deeper. (The old /telemetry and the
// short-lived /activity URLs 308-redirect here via next.config before this
// proxy runs.)
const PUBLIC_EXACT_PATHS = new Set<string>([
  "/",
  modelsPath(),
  creditsPath(),
  logsPath(),
  insightsPath(),
  // The marketing signup entry (`/signup?email=`) must be reachable signed-out;
  // it starts the code flow and redirects to /signin.
  signupPath(),
  // The security & reliability page is deliberately reachable signed-out: it
  // exists for prospective customers and external security reviewers who have
  // no account. (Privacy/Terms stay gated because they are only linked from
  // signed-in Settings.)
  securityPath(),
  // /yc is the shareable YC short link (a founder arrives signed-out from a DM /
  // Bookface): the page is a pure redirect to /signin?yc=1 (the deal lives on
  // sign-in). Gating it here bounces to a PLAIN /signin?next=/yc BEFORE that
  // redirect runs, dropping the yc=1 param and the launch-grant intent — so the
  // whole YC funnel entry dies. Public so the /yc -> /signin?yc=1 redirect fires.
  ycPath(),
  "/llms.txt"
]);
// The /auth prefix covers the whole password-reset flow too: /auth/reset (the
// sessionless request POST), /auth/reset/confirm (the emailed link's landing
// page), and /auth/reset/update (the confirm form's POST, riding the recovery
// session cookie). None of them may hit the 401 gate — the request POST has
// no session at all, and the recovery-session POST must reach its own route's
// getUser() check rather than the proxy's generic bounce.
const PUBLIC_PATH_PREFIXES = [signinPath(), "/auth", docsPath()];
// One path segment under /models: the shared detail URL. Anything deeper is workspace-only.
// Inlined literal (not interpolated from modelsPath()) because this is a
// security gate: a future path value with regex metacharacters must not widen it.
const PUBLIC_MODEL_DETAIL = /^\/models\/[^/]+$/;
// The browser-side mirror of the backend's one PUBLIC catalog read: the
// per-model detail proxy the UseViaKeyCard reads on the public model page
// (app/api/models/[modelSlug]/route.ts, GET only). Exactly one segment —
// /api/models itself (create) and everything deeper (providers, waterfall)
// carry mutations and stay session-gated.
const PUBLIC_MODEL_DETAIL_API = /^\/api\/models\/[^/]+$/;
// /api/cli/config is `wmh login` discovery: it publishes only the backend URL
// (already shown to every member on the Endpoints pages), never data.
// /api/stripe/webhook is Stripe's server-to-server callback: it carries no
// session and authenticates by webhook signature inside the route, so a
// cookie gate here would 401 every payment before that check runs (found
// live in BC-P3 — the proxy blocked all test-mode deliveries).
// /api/internal/auto-recharge is the auto-recharge poller: same shape, no
// session, authenticated by the CRON_SECRET bearer inside the route.
// /api/internal/spend-alerts is the pg_cron spend-alert delivery tick: same
// shape again (CRON_SECRET bearer inside the route; bad auth answers 404).
// /api/internal/balance-fetch is the pg_cron balance refresh: same shape again
// (CRON_SECRET bearer checked inside the route; bad auth answers 404).
// /api/signup/instant is the zero-friction instant-email signup a pasted
// coding agent calls with no session (it CREATES the account); it rate-limits
// and enforces the signups-enabled gate inside the route. A cookie gate here
// would 401 every signup before that logic runs.
const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/cli/config",
  "/api/stripe/webhook",
  "/api/signup/instant",
  "/api/internal/auto-recharge",
  "/api/internal/spend-alerts",
  "/api/internal/balance-fetch"
]);

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/auth/") || PUBLIC_API_PATHS.has(pathname)) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });
  const supabaseHeaders = new Headers();
  const settings = loadSupabaseAuthSettings();
  const supabase = createServerClient(settings.url, settings.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
        Object.entries(headers).forEach(([key, value]) => {
          supabaseResponse.headers.set(key, value);
          supabaseHeaders.set(key, value);
        });
      }
    }
  });

  const isAuthenticated = hasSupabaseAuthCookie(request.cookies.getAll())
    ? await hasVerifiedSession(supabase)
    : false;

  if (isPublicPath(pathname)) {
    // A signed-in user has no business on the auth surface: bounce to the
    // requested destination, or the workspace root redirect. EXCEPT the YC
    // deal variant (?yc=1): its signed-in render IS the product (auto-claim +
    // key + agent prompt, billing/BC-P8), and bouncing it also turns the
    // Overview's YC-intent guard into a redirect loop.
    if (
      isAuthenticated &&
      pathname === signinPath() &&
      request.nextUrl.searchParams.get("yc") !== "1"
    ) {
      const destination = safeNextPath(request.nextUrl.searchParams.get("next"));
      return withSupabaseSession(
        NextResponse.redirect(new URL(destination, request.url)),
        supabaseResponse,
        supabaseHeaders
      );
    }
    return supabaseResponse;
  }

  if (!isAuthenticated) {
    if (pathname.startsWith("/api/")) {
      return withSupabaseSession(
        NextResponse.json({ error: "Authentication required." }, { status: 401 }),
        supabaseResponse,
        supabaseHeaders
      );
    }
    const signinUrl = request.nextUrl.clone();
    signinUrl.pathname = signinPath();
    signinUrl.searchParams.set("next", `${pathname}${search}`);
    return withSupabaseSession(NextResponse.redirect(signinUrl), supabaseResponse, supabaseHeaders);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"]
};

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_API_PATHS.has(pathname) || PUBLIC_EXACT_PATHS.has(pathname)) {
    return true;
  }
  if (PUBLIC_MODEL_DETAIL.test(pathname) || PUBLIC_MODEL_DETAIL_API.test(pathname)) {
    return true;
  }
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function withSupabaseSession(
  response: NextResponse,
  supabaseResponse: NextResponse,
  supabaseHeaders: Headers
): NextResponse {
  supabaseResponse.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie);
  });
  supabaseHeaders.forEach((value, key) => {
    response.headers.set(key, value);
  });
  return response;
}

async function hasVerifiedSession(supabase: ReturnType<typeof createServerClient>): Promise<boolean> {
  // getClaims verifies the access token locally against the project's JWKS when the
  // signing key is asymmetric (production) and falls back to a GoTrue user lookup for
  // HS256 secrets (local stack, previews). Its internal getSession() still runs the
  // refresh path, so expired tokens are renewed and written back through the cookie
  // plumbing above.
  const { data, error } = await supabase.auth.getClaims();
  return error === null && data !== null;
}
