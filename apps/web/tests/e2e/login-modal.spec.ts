// The in-place login modal (gw-shell P4): gating opens a dialog on the page
// the visitor is on, a successful login advances it to the success step (API
// key, credits, docs link), and closing it leaves the visitor exactly where
// they were — signed in. The OAuth round-trip is exercised via its ?welcome=1
// return marker (a real provider redirect cannot run headlessly).
//
// Each test creates its own account through the inline create-confirm (the
// local stack runs with signups enabled), so the suite exercises the golden
// signup path: fresh workspace, first key minted on the success step.
//
// Run against a live stack (skips Playwright's own webServer entries):
//   EXPLABS_WEB_URL=http://localhost:3300 pnpm -C apps/web e2e tests/e2e/login-modal.spec.ts
import { expect, test, type Page } from "@playwright/test";

import { syntheticEmail } from "../synthetic-email";

// A deliverable plus-alias of the monitored mailbox, not a fabricated recipient:
// this suite can run against a hosted stack (EXPLABS_WEB_URL), where GoTrue
// really emails every signup and a made-up address would hard-bounce.
function freshEmail(tag: string): string {
  return syntheticEmail(`modal-${tag}`);
}

const PASSWORD = "e2e-modal-pass-1";

test.describe("login modal", () => {
  test("gates in place: modal signup on /models ends on the success step, no navigation", async ({
    page
  }) => {
    await page.goto("/models");
    await expect(page.getByTestId("login-modal")).toHaveCount(0);

    // The public rail's Log in affordance opens the modal (never /signin).
    // Expanded first: collapsed, the corner button sits under Next's
    // dev-tools badge in dev mode, which intercepts the click.
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.getByRole("button", { name: "Log in" }).click();
    const modal = page.getByTestId("login-modal");
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(/\/models/);

    await page.getByLabel("Email").fill(freshEmail("modal"));
    await page.getByLabel("Password").fill(PASSWORD);
    await modal.getByRole("button", { name: "Sign in", exact: true }).click();
    // Unknown address → inline confirm, then create in place.
    await modal.getByRole("button", { name: "Create account" }).click();

    // Success step: the fresh workspace's first key, minted here and shown
    // once in full, the ledger-gated welcome grant, and the two onward links.
    const success = page.getByTestId("login-success-step");
    await expect(success).toBeVisible();
    await expect(success.locator("code")).toContainText(/^xpl_[0-9a-f]{40}$/);
    await expect(success.getByText("This key won't be shown again — copy it now.")).toBeVisible();
    // The $20 welcome grant is the hero of the reveal, shown with the key.
    const credits = success.getByTestId("welcome-credits-line");
    await expect(credits).toContainText("$20");
    await expect(credits).toContainText("in free credits");
    // The three paste-into-your-coding-agent onboarding prompts, each copyable.
    await expect(success.getByRole("button", { name: "Copy Start chatting prompt" })).toBeVisible();
    await expect(
      success.getByRole("button", { name: "Copy Upload my traces prompt" })
    ).toBeVisible();
    await expect(
      success.getByRole("button", { name: "Copy Connect my provider keys prompt" })
    ).toBeVisible();
    await expect(success.getByRole("link", { name: /Docs/ })).toHaveAttribute("href", "/docs");
    await expect(success.getByRole("link", { name: /View your overview/ })).toHaveAttribute(
      "href",
      "/overview"
    );

    // Close in place: still on /models, now signed in (workspace rail with
    // the account block instead of the Log in button).
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("login-modal")).toHaveCount(0);
    await expect(page).toHaveURL(/\/models/);
    await expect(page.getByRole("button", { name: /Sign out/ })).toBeVisible();
  });

  test("an OAuth return (?welcome=1) reveals the key once, then never again", async ({ page }) => {
    // A full-page creation lands on Overview without minting a key, so the first
    // ?welcome=1 return is this account's initial key reveal.
    await createAccountFullPage(page, freshEmail("oauth-return"));

    await page.goto("/models?welcome=1");
    await expect(page.getByTestId("login-success-step")).toBeVisible();
    // The marker is stripped so a reload does not replay the celebration.
    await expect(page).toHaveURL(/\/models$/);

    // The org now holds a key, so a second ?welcome=1 never re-shows the reveal:
    // the modal is gated on the initial mint, not merely on the marker.
    await page.goto("/models?welcome=1");
    await expect(page).toHaveURL(/\/models$/);
    await expect(page.getByTestId("login-success-step")).toHaveCount(0);
    await expect(page.getByTestId("login-modal")).toHaveCount(0);
  });

  test("a hand-typed welcome marker does nothing signed out", async ({ page }) => {
    await page.goto("/models?welcome=1");

    await expect(page).toHaveURL(/\/models$/);
    await expect(page.getByTestId("login-modal")).toHaveCount(0);
  });

  test("a full-page /signin creation lands on the Overview, not a modal step", async ({
    page
  }) => {
    await createAccountFullPage(page, freshEmail("full-page"));

    await expect(page).toHaveURL(/\/overview/);
    await expect(page.getByTestId("login-modal")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  });
});

async function createAccountFullPage(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}
