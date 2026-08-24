import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RESERVED_ROOT_SLUGS, isReservedRouteSlug, reservedSlugRedirect } from "@/lib/routes";

// Workspace pages now live at the URL root (/models, /simulations, ...), so a
// legacy /{orgSlug}/... deep link still resolves through the [orgSlug] handler
// only when its first segment is NOT a real route — static segments win over
// the dynamic [orgSlug] segment. Runtime-minted org slugs always carry a random
// 8-char suffix (signup trigger, invite provisioning, admin create), so only
// hand-picked slugs — today, the two in supabase/seed.sql — can collide. This
// test guards both directions: a new seeded slug must not shadow a route, and a
// new top-level route must not shadow a seeded org. Route groups ("(workspace)")
// add no URL segment, so their children are top-level routes too.

const APP_DIR = join(__dirname, "..", "..", "app");
const SEED_SQL = join(__dirname, "..", "..", "..", "..", "supabase", "seed.sql");

function collectRouteSegments(dir: string): string[] {
  const segments: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("[")) {
      continue;
    }
    if (entry.name.startsWith("(")) {
      // A route group contributes no URL segment; its children are top-level.
      segments.push(...collectRouteSegments(join(dir, entry.name)));
      continue;
    }
    segments.push(entry.name);
  }
  return segments;
}

function topLevelSegments(): string[] {
  return collectRouteSegments(APP_DIR);
}

function seededOrgSlugs(): string[] {
  const sql = readFileSync(SEED_SQL, "utf8");
  const slugs: string[] = [];
  const insert =
    /insert into public\.organizations[^;]*?values\s*\(\s*'[^']*',\s*'([^']*)'/g;
  for (let match = insert.exec(sql); match !== null; match = insert.exec(sql)) {
    slugs.push(match[1]);
  }
  return slugs;
}

describe("reserved slugs", () => {
  it("finds the seeded org slugs (regex stays in sync with seed.sql)", () => {
    expect(seededOrgSlugs()).toEqual(
      expect.arrayContaining(["experiential-labs", "demo-examples"])
    );
  });

  it("no seeded org slug collides with a top-level route segment", () => {
    const segments = new Set(topLevelSegments());
    for (const slug of seededOrgSlugs()) {
      expect(segments).not.toContain(slug);
    }
  });

  // The models route (/models/{name}) and the [orgSlug] catch-all both
  // out-prioritize or defer to reserved static routes, so any top-level route
  // segment used as a model/org slug would render a phantom page or follow the
  // org cookie. RESERVED_ROOT_SLUGS is what both routes guard against; it must
  // cover every real top-level route or a newly added sibling page reopens the
  // swallow bug.
  it("reserves every top-level route segment", () => {
    for (const segment of topLevelSegments()) {
      expect(RESERVED_ROOT_SLUGS.has(segment)).toBe(true);
      expect(isReservedRouteSlug(segment)).toBe(true);
    }
  });

  it("redirects reserved slugs that have a landing page and 404s the rest", () => {
    // Sibling pages send the user to the real flat route.
    expect(reservedSlugRedirect("logs")).toBe("/logs");
    expect(reservedSlugRedirect("insights")).toBe("/insights");
    // The renamed old nouns still land on their new page.
    expect(reservedSlugRedirect("telemetry")).toBe("/logs");
    expect(reservedSlugRedirect("activity")).toBe("/insights");
    expect(reservedSlugRedirect("playground")).toBe("/playground");
    // Straight to the first section (Connections): /settings itself is a
    // redirect stub.
    expect(reservedSlugRedirect("settings")).toBe("/settings/connections");
    expect(reservedSlugRedirect("admin")).toBe("/admin");
    // Settings sub-pages that read as bare nouns land on their real page
    // (usage moved out of settings to /credits).
    expect(reservedSlugRedirect("usage")).toBe("/credits");
    expect(reservedSlugRedirect("api-keys")).toBe("/api-keys");
    expect(reservedSlugRedirect("aliases")).toBe("/aliases");
    // Reserved but non-navigable segments fall through to a 404.
    expect(reservedSlugRedirect("api")).toBeNull();
    expect(reservedSlugRedirect("onboarding")).toBeNull();
    expect(reservedSlugRedirect("auth")).toBeNull();
    expect(reservedSlugRedirect("cli")).toBeNull();
    // A normal name is not reserved.
    expect(isReservedRouteSlug("checkout-flow")).toBe(false);
    expect(reservedSlugRedirect("checkout-flow")).toBeNull();
  });

  it("maps every landing-page redirect target to a reserved slug", () => {
    // The redirect map is a subset of the reserved set: nothing redirects that
    // is not also guarded.
    for (const slug of [
      "models",
      "overview",
      "credits",
      "usage",
      "api-keys",
      "admin",
      "orgs"
    ]) {
      expect(isReservedRouteSlug(slug)).toBe(true);
      expect(reservedSlugRedirect(slug)).not.toBeNull();
    }
  });
});
