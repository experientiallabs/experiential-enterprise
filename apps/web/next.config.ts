import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    externalDir: true,
    // Client Router Cache lifetimes (the product owner, /models flash r2). With the default
    // dynamic=0 every navigation to a force-dynamic page re-fetches its RSC
    // payload and swaps in the route's loading fallback for the round trip —
    // /models flashed on EVERY visit even though the server render was a warm
    // cache hit. dynamic=30 keeps each visited page's payload in the client
    // router cache for 30s, so repeat navigations within the window render
    // INSTANTLY with no Suspense pass (the skeleton only ever shows on a true
    // cold first load). 30s is deliberate: it is long enough that clicking
    // around never suspends (frame-captured: zero white frames on any nav into
    // /models, warm revisits paint in ~40ms), and short enough that a
    // cross-session change (credits, membership, settings edited elsewhere)
    // is never served stale for minutes on unrelated force-dynamic pages —
    // the window applies to the WHOLE router cache, not just /models.
    staleTimes: {
      dynamic: 30,
      static: 180
    }
  },
  // Legacy auth/product routes redirect permanently (querystrings like
  // ?invite= and ?next= are preserved automatically) so emailed invite links
  // and bookmarks keep working. NOTE: /signup is a real route handler
  // (app/signup/route.ts, the marketing zero-form signup) — it must NOT be
  // redirected here, or Next.js would shadow the handler before it runs.
  async redirects() {
    return [
      { destination: "/signin", permanent: true, source: "/login" },
      // Usage and API keys moved into Settings (D-IA update, 2026-07-25).
      // Bookmarks and the legacy org-prefixed 308 chains land here; without
      // these the old paths fell through to the org catch-all and 404ed.
      { destination: "/settings/usage", permanent: true, source: "/usage" },
      // API keys and named aliases moved OUT of /settings to top-level pages
      // (the product owner, D-IA 2026-08-20); old settings links redirect to the new routes.
      { destination: "/api-keys", permanent: true, source: "/settings/api-keys" },
      { destination: "/aliases", permanent: true, source: "/settings/aliases" },
      // The standalone Simulation product is retired. Every bookmark terminates
      // in the retained Models surface before a removed page can fetch an API.
      { destination: "/models", permanent: true, source: "/simulations" },
      { destination: "/models", permanent: true, source: "/simulations/:path*" },
      { destination: "/models", permanent: true, source: "/world-models" },
      { destination: "/models", permanent: true, source: "/world-models/:path*" },
      // The old public landing roots follow the same retained door.
      { destination: "/models", permanent: true, source: "/explore" },
      { destination: "/models", permanent: true, source: "/explore/:path*" },
      { destination: "/models", permanent: true, source: "/wm" },
      { destination: "/models", permanent: true, source: "/wm/:path*" },
      // Telemetry -> Logs (the product owner, IA 2026-08-22): the usage surfaces were
      // renamed to match the OpenRouter-style split (Logs = the raw per-request
      // table, Insights = the deep analytics dashboard). The Insights dashboard
      // briefly shipped as /activity in the same effort; /activity redirects to
      // /insights so that short-lived link never dead-ends. Old bookmarks and
      // any shared filtered link (?window=... etc) redirect with their query
      // string preserved.
      { destination: "/logs", permanent: true, source: "/telemetry" },
      { destination: "/insights", permanent: true, source: "/activity" }
    ];
  }
};

export default nextConfig;
