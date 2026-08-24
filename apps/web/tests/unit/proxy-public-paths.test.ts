import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/proxy";

// Absorbed from the closed #277 (its parallel catalog impl is superseded, but its
// proxy-paths guard is worth keeping): the unauthenticated door and the auth surfaces
// stay reachable signed-out, and everything else stays gated. The door moved from
// /simulations to /models on 2026-07-29, which is what these assertions pin.
describe("proxy public paths", () => {
  it("keeps the models door and auth surfaces public", () => {
    // /models serves the published default models (exact) and /models/<slug> the shared
    // per-model detail pages; both are reachable without a session.
    expect(isPublicPath("/models")).toBe(true);
    expect(isPublicPath("/models/tau-bench")).toBe(true);
    // Anything deeper under a model is workspace-only.
    expect(isPublicPath("/models/tau-bench/settings")).toBe(false);
    expect(isPublicPath("/signin")).toBe(true);
    // The password-reset flow rides the /auth prefix: the sessionless request
    // POST, the emailed link's landing page, and the recovery-session update
    // POST must all reach their routes instead of the proxy's 401/redirect.
    expect(isPublicPath("/auth/password/reset")).toBe(true);
    expect(isPublicPath("/auth/password/reset/confirm")).toBe(true);
    // The retired /api/public tree lost its 410 handlers with the deleted
    // Simulation surfaces; nothing under it may ship unauthenticated again.
    expect(isPublicPath("/api/public/world-models/tau-bench/sessions")).toBe(false);
    expect(isPublicPath("/api/public/sessions/abc/step")).toBe(false);
  });

  it("keeps the API documentation public: integrators and agents read it without a session", () => {
    // /docs is the human reference and /llms.txt the machine-readable one
    // (the product owner, 2026-07-30); both must be linkable and scrapeable signed-out.
    // /docs widened to a prefix for the launch docs site (gw-docs P1): every
    // docs page renders signed-out. /docs/internal is public at the proxy by
    // design — the route itself owns the admin 404 gate (docs-P7).
    expect(isPublicPath("/docs")).toBe(true);
    expect(isPublicPath("/docs/quickstart")).toBe(true);
    expect(isPublicPath("/docs/core-loop")).toBe(true);
    expect(isPublicPath("/docs/errors")).toBe(true);
    expect(isPublicPath("/docs/reference")).toBe(true);
    // A lookalike sibling does not ride the prefix.
    expect(isPublicPath("/docsy")).toBe(false);
    expect(isPublicPath("/llms.txt")).toBe(true);
  });

  it("keeps /credits public: the page renders signed-out with gated actions", () => {
    // The gating contract (design-system "Gating patterns"): pages are
    // public, actions gate. The credits page renders empty-state numbers
    // signed-out; its org-scoped API reads stay session-gated below.
    expect(isPublicPath("/credits")).toBe(true);
    // Only the exact page: nothing deeper exists under it.
    expect(isPublicPath("/credits/history")).toBe(false);
    expect(isPublicPath("/api/orgs/org-1/credit/ledger")).toBe(false);
    expect(isPublicPath("/api/orgs/org-1/budget")).toBe(false);
  });

  it("keeps /yc public so its redirect to /signin?yc=1 fires, preserving the funnel", () => {
    // /yc is the shareable YC short link; a founder arrives signed-out from a
    // DM/Bookface. The page is a pure redirect to /signin?yc=1. If /yc gated
    // here, the signed-out visitor bounces to a PLAIN /signin?next=/yc BEFORE
    // that redirect runs, dropping yc=1 and the launch-grant intent — the whole
    // funnel entry dies (the "signed up via /yc but no credits" incident).
    expect(isPublicPath("/yc")).toBe(true);
  });

  it("keeps /logs public: signed-out visitors reach the demo, not a sign-in bounce", () => {
    // The Logs page (formerly /telemetry) is the signed-out storefront: page.tsx
    // renders the full usage surface over deterministic DEMO data for a
    // signed-out visitor and only "see your OWN usage" requires signing in. If
    // the proxy gated it, that demo would be unreachable (the visitor bounces to
    // /signin first).
    expect(isPublicPath("/logs")).toBe(true);
    // Only the exact page — filters ride the query string, so nothing deeper.
    expect(isPublicPath("/logs/anything")).toBe(false);
    // The org-scoped usage reads the page calls stay session-gated.
    expect(isPublicPath("/api/orgs/org-1/usage/by-key")).toBe(false);
    expect(isPublicPath("/api/orgs/org-1/usage/imported")).toBe(false);
  });

  it("keeps /insights public: signed-out visitors reach the locked teaser, not a bounce", () => {
    // /insights renders a locked teaser (<InsightsLocked/>) signed-out — a
    // storefront surface linked from PublicSidebar. Gating it would bounce the
    // link to /signin. It reads no tenant data; the NL-query API stays gated.
    expect(isPublicPath("/insights")).toBe(true);
    // Only the exact page — the question rides the request body, not the path.
    expect(isPublicPath("/insights/anything")).toBe(false);
    expect(isPublicPath("/api/orgs/org-1/insights/query")).toBe(false);
  });

  it("keeps /security public: prospective customers and security reviewers read it without an account", () => {
    // The security & reliability page is a signed-out storefront surface; if the
    // proxy gated it, an external reviewer with no account would bounce to
    // /signin?next=/security and never reach it.
    expect(isPublicPath("/security")).toBe(true);
    // Only the exact page — nothing deeper exists under it.
    expect(isPublicPath("/security/anything")).toBe(false);
  });

  it("keeps the Stripe webhook reachable: it authenticates by signature, not session", () => {
    // Stripe's server-to-server callback carries no Supabase cookies; gating
    // it here 401s every payment before the route's signature check runs.
    expect(isPublicPath("/api/stripe/webhook")).toBe(true);
    // Only the exact path: nothing else under /api/stripe exists or ships open.
    expect(isPublicPath("/api/stripe")).toBe(false);
    expect(isPublicPath("/api/stripe/webhook/replay")).toBe(false);
  });

  it("keeps the internal cron routes reachable: they authenticate by CRON_SECRET bearer, not session", () => {
    // The pg_cron ticks and the auto-recharge poller carry no Supabase
    // cookies; gating them here 401s the scheduler before the route's own
    // bearer check runs. The routes answer 404 on a bad bearer, so the
    // exemption reveals nothing.
    expect(isPublicPath("/api/internal/spend-alerts")).toBe(true);
    expect(isPublicPath("/api/internal/auto-recharge")).toBe(true);
    // Only the exact paths: the /api/internal prefix itself stays gated.
    expect(isPublicPath("/api/internal")).toBe(false);
    expect(isPublicPath("/api/internal/spend-alerts/replay")).toBe(false);
  });

  it("keeps instant coding-agent signup reachable without a session", () => {
    // A pasted coding agent calls /api/signup/instant with no cookies to
    // create the account; gating it here 401s every signup before the route's
    // rate-limit + signups-enabled check runs (the route is the authority).
    expect(isPublicPath("/api/signup/instant")).toBe(true);
    // Only the exact path stays open; nothing deeper under /api/signup does.
    expect(isPublicPath("/api/signup")).toBe(false);
    expect(isPublicPath("/api/signup/instant/replay")).toBe(false);
  });

  it("gates the simulations surface, which is no longer the public door", () => {
    expect(isPublicPath("/simulations")).toBe(false);
    expect(isPublicPath("/simulations/tau-bench")).toBe(false);
    expect(isPublicPath("/simulations/tau-bench/playground")).toBe(false);
  });

  it("keeps the member workspace and tenant API behind authentication", () => {
    // "/" resolves per audience (HomePage redirects signed-out visitors to /models), so it
    // must reach the app rather than bounce them to sign-in.
    expect(isPublicPath("/")).toBe(true);
    // The shared /models/<slug> detail URL is public at the proxy (the layout/page bounce
    // non-default slugs to sign-in without confirming a tenant model exists), but the rest
    // of the workspace stays members-only.
    expect(isPublicPath("/models/acme-private-model")).toBe(true);
    expect(isPublicPath("/settings")).toBe(false);
    // Tenant APIs stay gated.
    expect(isPublicPath("/api/orgs/org-1/world-models")).toBe(false);
  });

  it("keeps the one public catalog API read open and every catalog mutation gated", () => {
    // The UseViaKeyCard reads model detail on the PUBLIC model page, so its
    // proxy must answer signed out (the backend serves the public catalog
    // view to an actorless request).
    expect(isPublicPath("/api/models/kimi-k2.6")).toBe(true);
    // Create and everything deeper (providers, waterfall) carry mutations.
    expect(isPublicPath("/api/models")).toBe(false);
    expect(isPublicPath("/api/models/kimi-k2.6/providers")).toBe(false);
    expect(isPublicPath("/api/models/kimi-k2.6/waterfall")).toBe(false);
  });

});
