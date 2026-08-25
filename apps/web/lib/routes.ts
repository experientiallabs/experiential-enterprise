// Typed builders for the workspace and top-level navigation routes; nav call
// sites resolve their hrefs here rather than writing path literals. Two
// families stay inline by design and are NOT modeled here: the /auth/oauth/...
// sign-in flow hrefs (built from the provider id in OAuthButtons) and the raw
// /auth/... route handlers. The URL scheme is ROOT-LEVEL: workspace pages carry
// no org
// segment; the active org is a server-side resolution (lib/active-org.ts,
// cookie with first-authorized-org fallback) and the org switcher writes it
// through /api/active-org. Entities are addressed by their per-org-unique
// `name`. Legacy /{orgSlug}/... and /orgs/{uuid}/... URLs permanently
// redirect (the app/[orgSlug] and app/orgs catch-all handlers); world-model
// pages canonicalize a legacy UUID identifier to its slug URL themselves.

export function signinPath(): string {
  return "/signin";
}

// The public model catalog: the signed-out door at "/" and the gateway's
// storefront. One URL for both audiences — the catalog is public and only
// actions (keys, credits) gate. next.config redirects retired /simulations
// bookmarks here.
export function modelsPath(): string {
  return "/models";
}

// The signed-in home: the personal usage Overview, the one authenticated-only
// page in the product. "/" sends members here.
export function overviewPath(): string {
  return "/overview";
}

/**
 * Query marker a brand-new signup rides so the destination page opens the
 * login modal directly on its success step (the one-time API-key reveal). Set
 * by the in-modal OAuth round-trip (LoginModal `oauthNext`) and by the
 * full-page code-first `/signup` flow after verification; consumed and then stripped by
 * `WelcomeReturnListener` (components/auth/login-modal-context.tsx) so a reload
 * or shared URL never replays the reveal. A returning sign-in never sets it.
 *
 * Single-sourced here so the full-page signin form and client modal share ONE
 * contract; the marker cannot be imported as a value from the "use client"
 * modal module into a server route.
 */
export const WELCOME_PARAM = "welcome";

/** The signed-in Overview with the one-time welcome-reveal marker set. */
export function overviewWelcomePath(): string {
  return `${overviewPath()}?${WELCOME_PARAM}=1`;
}

// Where the emailed password-recovery link lands (after /auth/callback seats the
// recovery session): the set-a-new-password form. A literal top-level route, so
// it is not shadowed by the [orgSlug] catch-all.
export function resetPasswordPath(): string {
  return "/reset-password";
}

export function modelPath(modelSlug: string): string {
  return `/models/${modelSlug}`;
}

export function playgroundPath(modelSlug?: string): string {
  return modelSlug ? `/playground?model=${encodeURIComponent(modelSlug)}` : "/playground";
}

/**
 * The playground in compare mode: every slug becomes a side-by-side pane
 * answering the same prompt. The compare board's "Open in playground" builds
 * this; the playground itself mirrors pane changes back to the same shape.
 */
export function playgroundComparePath(modelSlugs: string[]): string {
  if (modelSlugs.length <= 1) {
    return playgroundPath(modelSlugs[0]);
  }
  return `/playground?models=${modelSlugs.map(encodeURIComponent).join(",")}`;
}

// Logs: the raw per-request gateway log (formerly "Telemetry"). Filtered log
// views are still shareable — the page writes its filter state to the URL
// itself (lib/gateway-telemetry.ts); no surface builds a pre-filtered link, so
// the path helper carries no params. `/telemetry` redirects here for old links.
export function logsPath(): string {
  return "/logs";
}

// Insights: the deep usage-analytics dashboard — every graph shown by default,
// with the natural-language "Intelligence" query and usage-tied suggestions
// folded in as a tab. `/activity` redirects here for old links. The Overview's
// "View full activity" link points here.
export function insightsPath(): string {
  return "/insights";
}

// The public documentation section: a multi-page docs site (overview,
// quickstart, core loop, models, errors, API reference), all readable
// signed-out — the proxy exempts the whole /docs prefix. The sidebar IA lives
// in components/docs/docs-nav.ts and consumes these helpers.
export function docsPath(): string {
  return "/docs";
}

export function docsQuickstartPath(): string {
  return "/docs/quickstart";
}

export function docsCoreLoopPath(): string {
  return "/docs/core-loop";
}

export function docsSetupPromptsPath(): string {
  return "/docs/setup-prompts";
}

export function docsAuthenticationPath(): string {
  return "/docs/authentication";
}

export function docsAnthropicPath(): string {
  return "/docs/anthropic";
}

export function docsBillingPath(): string {
  return "/docs/billing";
}

export function docsTelemetryPath(): string {
  return "/docs/telemetry";
}

export function docsModelsPath(): string {
  return "/docs/models";
}

export function docsCodingAgentsPath(): string {
  return "/docs/coding-agents";
}

export function docsErrorsPath(): string {
  return "/docs/errors";
}

export function docsReferencePath(): string {
  return "/docs/reference";
}

// Admin-only internal API reference: registered but unlisted (docs-P7 adds the
// admin gate); never rendered in the public sidebar or search index.
export function docsInternalPath(): string {
  return "/docs/internal";
}

export function usagePath(): string {
  return "/settings/usage";
}

/** Credit balance, history, and top-ups; public page, gated actions. */
export function creditsPath(): string {
  return "/credits";
}

/**
 * The marketing signup entry: the website's "Get API key" sends the browser
 * here with the visitor's email, and this route starts the six-digit code flow
 * (see apps/web/app/signup/route.ts). A bare hit with no email falls back to
 * /signin.
 */
export function signupPath(): string {
  return "/signup";
}

/**
 * The shared YC short link (redirects to the sign-in page's YC-deal variant).
 * Deliberately unadvertised: the URL travels by DM/Bookface, so no nav
 * surface may link it.
 */
export function ycPath(): string {
  return "/yc";
}

/**
 * The sign-in page's YC-deal variant: YC branding, and a login here
 * auto-claims the $526 launch grant. /yc redirects here; the param must
 * survive the OAuth round-trip, so it rides the oauth `next` target.
 */
export function ycSigninPath(): string {
  return "/signin?yc=1";
}

// API keys are a first-class top-level page, not a Settings section (the product owner,
// D-IA 2026-08-20): keeping them under /settings/api-keys made the rail light
// both "API Keys" and "Settings" at once. Old /settings/api-keys links redirect
// here (next.config).
export function apiKeysPath(): string {
  return "/api-keys";
}

// The "Access control" surface (sidebar label; page renamed from "Aliases &
// access" 2026-08-23, path unchanged), a first-class top-level page: named model
// aliases plus the identities/grants/budgets panel that used to live at
// /settings/identities (folded in here, credits/settings redesign 2026-08-22,
// so access management is not buried in settings). The old settings URL
// redirects here.
export function aliasesPath(): string {
  return "/aliases";
}

export function settingsPath(): string {
  return "/settings";
}

// Settings sections. API keys is a section under /settings, not a top-level
// page (D-IA 2026-07-25); billing moved OUT of settings to top-level /credits
// and the old /settings/usage URL is a redirect page, so there is no
// usagePath() helper anymore.
export function membersSettingsPath(): string {
  return "/settings/members";
}

export function organizationSettingsPath(): string {
  return "/settings/organization";
}

// Connections: the org's outbound hookups on ONE page — BYOK model-provider
// accounts first, then the observability trace sources (the product owner, credits/settings
// redesign 2026-08-22: Providers + Observability collapsed into one section).
// The old /settings/providers, /settings/observability, and
// /settings/integrations URLs all redirect here; `returnTo` carries the page
// to come back to once the connect flow finishes.
export function connectionsSettingsPath(returnTo?: string): string {
  return returnTo === undefined
    ? "/settings/connections"
    : `/settings/connections?returnTo=${encodeURIComponent(returnTo)}`;
}

/** The org audit trail (admin-gated section; enterprise build-out). */
export function auditSettingsPath(): string {
  return "/settings/audit";
}

/** Verified domains + IdP registration (admin-gated /ee section; E2). */
export function ssoSettingsPath(): string {
  return "/settings/sso";
}

/** Org teams management (/ee section; E4). */
export function teamsSettingsPath(): string {
  return "/settings/teams";
}

/** SCIM provisioning token (admin-gated /ee section; E3). */
export function scimSettingsPath(): string {
  return "/settings/scim";
}

/** Provider data-control policy (/ee section; E5.3). */
export function dataControlsSettingsPath(): string {
  return "/settings/data-controls";
}

export function accountSettingsPath(): string {
  return "/settings/account";
}

export function privacyPath(): string {
  return "/privacy";
}

export function termsPath(): string {
  return "/terms";
}

export function securityPath(): string {
  return "/security";
}

export function adminPath(): string {
  return "/admin";
}

/** The admin Users section: every auth account, with ban/unban controls. */
export function adminUsersPath(): string {
  return "/admin/users";
}

export function adminTelemetryPath(): string {
  return "/admin/telemetry";
}

/** The admin Access section: superadmin machine keys (mint/revoke). */
export function adminAccessPath(): string {
  return "/admin/access";
}

export function adminPlatformPath(): string {
  return "/admin/platform";
}

/** The admin Promotions section: CRUD over the promotional-model set. */
/** The Enterprise section: per-org /ee entitlement grants (operator-only). */
export function adminEnterprisePath(): string {
  return "/admin/enterprise";
}

export function adminPromotionsPath(): string {
  return "/admin/promotions";
}

/** The admin Experiential Cloud section: attach EC lanes, price them, on/off. */
export function adminExperientialCloudPath(): string {
  return "/admin/experiential-cloud";
}

/** A single organization's admin detail page (management, members, deletion). */
export function adminOrgPath(orgId: string): string {
  return `/admin/orgs/${orgId}`;
}

export function orgsPath(): string {
  return "/orgs";
}

// Reserved first-path segments the router owns. Two routes consult this set:
//   1. app/[orgSlug]/[[...rest]] (the legacy-org catch-all) treats a first
//      segment as an org slug and follows the org cookie. A reserved route name
//      reaching it (e.g. /usage, or /telemetry/extra past the static leaf) is
//      NOT an org, so the guard resolves it as an app path instead of silently
//      redirecting through a stale bookmark - the swallow hazard when a new
//      top-level slug is not registered as a static route.
//   2. app/(workspace)/models/[modelSlug]: "models" is a static segment, so
//      /models/{name} out-prioritizes the catch-all and a name colliding with a
//      sibling route (/models/telemetry) would otherwise render the model page
//      with no such model ("No model named telemetry here").
// Both send a reserved slug to its real page (reservedSlugRedirect) or a plain
// 404.
//
// This set must stay in lockstep with the top-level route tree; the reserved
// route test reads app/ and app/(workspace)/ and fails if any navigable
// top-level segment is missing here.
export const RESERVED_ROOT_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "auth",
  "cli",
  "connect-traces",
  "create-project",
  "docs",
  "onboarding",
  "orgs",
  "privacy",
  "security",
  "signin",
  "signup",
  "reset-password",
  "terms",
  "models",
  "overview",
  "credits",
  "playground",
  "projects",
  "settings",
  "logs",
  "insights",
  // Old usage-surface slugs kept reserved so a seeded/collision slug can never
  // shadow the next.config redirects that point them at /logs and /insights.
  "telemetry",
  "activity",
  "simulations",
  "yc",
  // The machine-readable API reference (a text route handler, not a page).
  "llms.txt",
  // API keys and named aliases are first-class top-level pages (D-IA 2026-08-20).
  "api-keys",
  "aliases",
  // Settings sub-pages that also read as product nouns; not top-level routes,
  // but reserved so a model named "usage"/"connections" cannot shadow them.
  "usage",
  "providers",
  "observability",
  "connections"
]);

// The reserved slugs that have a user-facing landing page, mapped to it. A
// collision redirects here (the page the user most likely meant); reserved
// slugs absent from this map (api, auth, cli) are not navigable pages and fall
// through to a 404 instead.
const RESERVED_SLUG_REDIRECTS: Readonly<Record<string, string>> = {
  docs: docsPath(),
  models: modelsPath(),
  overview: overviewPath(),
  credits: creditsPath(),
  playground: playgroundPath(),
  // Straight to the first section (Connections): /settings is a redirect stub,
  // and routing a collision through it would take two hops to land.
  settings: connectionsSettingsPath(),
  logs: logsPath(),
  insights: insightsPath(),
  // The renamed surfaces' old nouns still land on their new page, so a seeded
  // or collision slug never dead-ends.
  telemetry: logsPath(),
  activity: insightsPath(),
  simulations: modelsPath(),
  yc: ycPath(),
  // The old usage section is now the /credits page; skip the redirect hop.
  usage: creditsPath(),
  "api-keys": apiKeysPath(),
  aliases: aliasesPath(),
  // The retired settings-section nouns land on their merged Connections home.
  providers: connectionsSettingsPath(),
  observability: connectionsSettingsPath(),
  connections: connectionsSettingsPath(),
  signin: signinPath(),
  privacy: privacyPath(),
  terms: termsPath(),
  security: securityPath(),
  admin: adminPath(),
  orgs: orgsPath()
};

/** True when `slug` names a route the app owns and so cannot be an org/model slug. */
export function isReservedRouteSlug(slug: string): boolean {
  return RESERVED_ROOT_SLUGS.has(slug);
}

/**
 * The flat page a reserved slug should redirect to, or `null` when the reserved
 * slug has no navigable page (caller should render a 404).
 */
export function reservedSlugRedirect(slug: string): string | null {
  return RESERVED_SLUG_REDIRECTS[slug] ?? null;
}
