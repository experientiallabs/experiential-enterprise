// Happy-path smoke against a LIVE stack (docker compose web on :3300 by default).
// This spec never starts its own servers — always point EXPLABS_WEB_URL at a
// running web container so playwright.config.ts skips its webServer entries:
//
//   EXPLABS_WEB_URL=http://localhost:3300 pnpm -C apps/web e2e tests/e2e/live-stack.spec.ts
//
// Credentials default to the docker/compose.yml seeded admin user; override with
// EXPLABS_AUTH_ADMIN_EMAIL / EXPLABS_AUTH_ADMIN_PASSWORD for other stacks.
import { expect, test } from "@playwright/test";

const adminEmail = process.env.EXPLABS_AUTH_ADMIN_EMAIL ?? "admin@xplabs.ai";
const adminPassword = process.env.EXPLABS_AUTH_ADMIN_PASSWORD ?? "3XP321!";

const liveStackConfigured = Boolean(process.env.EXPLABS_WEB_URL);

test.describe("live-stack happy path", () => {
  test.skip(!liveStackConfigured, "Set EXPLABS_WEB_URL to a running web container (e.g. http://localhost:3300)");

  test("login -> orgs -> Overview and retired bookmarks redirect", async ({ page }) => {
    await page.goto("/signin");
    await page.context().addCookies([
      { name: "explabs-active-org", value: "experiential-labs", url: page.url() }
    ]);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    // Full-page logins land on the personal Overview (gw-shell P4).
    await page.waitForURL("**/overview");

    await page.goto("/orgs");
    await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
    const demoCard = page.getByRole("button", { name: /Demo/ }).first();
    await expect(demoCard).toBeVisible();
    await demoCard.click();
    // Switching org lands on that org's Overview (gw-shell P5).
    await page.waitForURL("**/overview");

    await expect(page.getByRole("link", { name: "Simulations" })).toHaveCount(0);
    await page.goto("/simulations/tau-bench/playground");
    await expect(page).toHaveURL(/\/models$/);
  });

  test("sidebar survives navigation without remounting", async ({ page }) => {
    // The shell mounts once in the (workspace) group layout; before 2026-07-30
    // every sidebar surface carried its own AppShell, so each click remounted
    // the sidebar and flashed its skeleton. A remount replaces the DOM node,
    // which drops the expando marker planted here.
    await page.goto("/signin");
  // Pin the operator workspace: a fresh session's default org is the
  // publisher (default-models) org, whose member surfaces are not what
  // these specs assert.
  await page.context().addCookies([
    { name: "explabs-active-org", value: "experiential-labs", url: page.url() }
  ]);
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/overview");

    await page.goto("/models");
    // The whole rail: primary nav on top, Admin/Settings in the footer nav.
    const sidebarNav = page.getByRole("complementary");
    await expect(sidebarNav.getByRole("link", { name: "Simulations" })).toHaveCount(0);
    await page.evaluate(() => {
      const aside = document.querySelector("aside");
      (aside as HTMLElement & { __shellMounted?: boolean }).__shellMounted = true;
    });

    // Settings lands on its first section and Admin is workspace chrome too
    // (both used to remount the shell: Settings via a redirect stub, Admin via
    // its own AppShell outside the group).
    const stops: Array<[string, string]> = [
      ["Overview", "**/overview"],
      // Playground is hidden from the nav now (page reachable by direct URL),
      // so it is no longer a click-through stop in the rail.
      // Ungated since 2026-07-30: Logs renders traffic or not.
      ["Logs", "**/logs"],
      // /settings is a redirect stub to the first section (Providers, now that
      // Usage moved to /credits and API Keys is its own top-level page).
      ["Settings", "**/settings/connections"],
      ["Admin", "**/admin"],
      ["Models", "**/models"]
    ];
    for (const [label, urlPattern] of stops) {
      await sidebarNav.getByRole("link", { name: label }).click();
      await page.waitForURL(urlPattern);
      await expect(sidebarNav.getByRole("link", { name: label })).toBeVisible();
      const stillMounted = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        return (aside as HTMLElement & { __shellMounted?: boolean })?.__shellMounted === true;
      });
      expect(stillMounted, `sidebar remounted navigating to ${label}`).toBe(true);
    }
  });

  test("settings and admin tab bars survive their own navigation", async ({ page }) => {
    // Same expando technique one level down: each layout-owned tab bar must
    // survive a section click without being torn down and repainted.
    await page.goto("/signin");
  // Pin the operator workspace: a fresh session's default org is the
  // publisher (default-models) org, whose member surfaces are not what
  // these specs assert.
  await page.context().addCookies([
    { name: "explabs-active-org", value: "experiential-labs", url: page.url() }
  ]);
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/overview");

    await page.goto("/settings/connections");
    const settingsNav = page.getByRole("navigation", { name: "Settings sections" });
    await expect(settingsNav).toBeVisible();
    await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Settings sections"]');
      (nav as HTMLElement & { __mounted?: boolean }).__mounted = true;
    });
    // API Keys and Access control are first-class sidebar entries now, not Settings
    // tabs (the product owner, gw-r2 IA fix), so this mount-persistence check crosses two
    // remaining sections instead.
    await settingsNav.getByRole("link", { name: "Members" }).click();
    await page.waitForURL("**/settings/members");
    await expect(settingsNav.getByRole("link", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(
      await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]');
        return (nav as HTMLElement & { __mounted?: boolean })?.__mounted === true;
      }),
      "settings tab bar remounted on a section click"
    ).toBe(true);

    // Admin: the same layout-owned tab bar. Only the Organizations section
    // exists since the Runs surface retired with the #441 consolidation, so
    // there is no admin section navigation left to exercise — assert the
    // panel renders for a platform admin.
    await page.goto("/admin");
    await expect(page.getByRole("navigation", { name: "Admin sections" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Organizations and members" })
    ).toBeVisible();
  });

  // Billing surface (gw/billing-bc2): kept alongside the final-IA edits above —
  // the fold carries billing, so its coverage must not vanish with the IA pass.
  test("/credits renders both audiences and /settings/usage redirects there", async ({
    page
  }) => {
    // Signed-out first (Contract 5): the full page with empty-state numbers
    // and the gated checkout action — never a bounce to /signin.
    await page.goto("/credits");
    await expect(page).toHaveURL(/\/credits$/);
    await expect(page.getByRole("heading", { name: "Credits", exact: true })).toBeVisible();
    await expect(page.getByText("of $0.00 credits")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to payment" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Credit history" })).toBeVisible();

    await page.goto("/signin");
    await page.context().addCookies([
      { name: "explabs-active-org", value: "experiential-labs", url: page.url() }
    ]);
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/overview");

    // The old settings section redirects to the page (Stripe return URLs from
    // sessions minted before the move ride the same redirect).
    await page.goto("/settings/usage");
    await page.waitForURL("**/credits");
    await expect(page.getByTestId("spend-overview")).toBeVisible();
    await expect(page.getByTestId("credit-history")).toBeVisible();
    // The seeded org carries real counters; the hero shows dollars, not the
    // signed-out zeros ("of $X.XX credits" with a nonzero grant).
    await expect(page.getByText(/of \$\d/)).toBeVisible();
  });
});
