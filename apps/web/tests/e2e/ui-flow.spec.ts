// Re-enabled: the historical `getByLabel("Email")` flakiness was caused by the
// sign-in form labels lacking htmlFor/id association (fixed in app/signin/SigninForm.tsx).
//
// Run against a live stack (skips Playwright's own webServer entries):
//   EXPLABS_WEB_URL=http://localhost:3300 pnpm -C apps/web e2e tests/e2e/ui-flow.spec.ts
import { expect, test, type Page } from "@playwright/test";

const adminEmail = process.env.EXPLABS_AUTH_ADMIN_EMAIL ?? "admin@xplabs.ai";
const adminPassword = process.env.EXPLABS_AUTH_ADMIN_PASSWORD ?? "3XP321!";

test.describe("e2e UI flow", () => {
  test("requires auth for data APIs while pages stay public", async ({ page, request }) => {
    const apiResponse = await request.get("/api/orgs");
    expect(apiResponse.status()).toBe(401);

    // /settings is a gated workspace page (unlike the public /logs demo,
    // /insights teaser, and /yc short link): a signed-out visitor bounces.
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/signin\?next=/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("opens /models without a session, behind the provider gate", async ({ page }) => {
    // /models is the door for both audiences: the route renders signed-out
    // with no sign-in bounce. This build gates the catalog DISPLAY on a
    // provider connection, and a signed-out visitor has none, so what renders
    // is the connect-a-provider prompt with the add-a-model door beside it.
    await page.goto("/models");
    await expect(page).toHaveURL(/\/models$/);
    await expect(
      page.getByRole("heading", { name: "Connect a provider to see models" })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Add model" })).toBeVisible();

    // The signed-out rail is the same unified sidebar: public nav plus a Log
    // in button, no Overview, no locked entries.
    const rail = page.getByRole("complementary");
    // Playground is hidden from the nav (page stays reachable by direct URL).
    await expect(rail.getByRole("link", { name: "Playground" })).toHaveCount(0);
    await expect(rail.getByRole("link", { name: "Docs" })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Log in" })).toBeVisible();
    await expect(rail.getByRole("link", { name: "Overview" })).toHaveCount(0);

    // Retired Simulation bookmarks terminate at /models.
    await page.goto("/simulations");
    await expect(page).toHaveURL(/\/models/);
  });

  test("opens a model detail signed out, no sign-in bounce", async ({ page }) => {
    // Model details are public in the gateway topology: claude-opus-5 is a
    // seeded catalog row, and its detail renders signed out with the stable
    // "Open in Playground" action (the action itself gates later).
    await page.goto("/models/claude-opus-5");
    await expect(page).toHaveURL(/\/models\/claude-opus-5$/);
    await expect(page.getByRole("link", { name: "Open in Playground" })).toBeVisible();
  });

  test("signs in to a workspace without a standalone Simulations entry", async ({ page }) => {
    await signIn(page);
    // Signed-in "/" and post-login land on the personal Overview now.
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByLabel("Switch organization")).toBeVisible();
    await expect(page.getByRole("link", { name: "Simulations" })).toHaveCount(0);
    // Playground is hidden from the nav (page stays reachable by direct URL).
    await expect(page.getByRole("link", { name: "Playground" })).toHaveCount(0);
    // API Keys and Access control (/aliases) are top-level entries in the
    // final IA; Settings holds the org/account sections.
    await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Agents" })).toHaveCount(0);
    // Every retired bookmark terminates at Models.
    await page.goto("/simulations");
    await expect(page).toHaveURL(/\/models/);
  });

  test("lists all organizations from the organizations grid", async ({ page }) => {
    await signIn(page);
    await page.goto("/orgs");
    await expect(page.getByRole("heading", { name: "Organizations" })).toBeVisible();
  });
});

async function signIn(page: Page) {
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
  // Full-page logins land on the personal Overview (gw-shell P4); members
  // with no org land on /orgs to create one.
  await page.waitForURL(/\/(overview|models|orgs)/);
}
