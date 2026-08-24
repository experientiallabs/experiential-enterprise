import { fireEvent, render as renderBare, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/models" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { AppSidebar, type AppSidebarSession } from "@/components/shell/AppSidebar";
import type { Org } from "@/lib/types";

// The one sidebar for every visitor (gw-shell P3). This suite pins the
// audience split from the packet's done-when: signed-out shows the public nav
// with a Log in button (modal, never /signin) and none of the member chrome;
// signed-in adds Overview, the org switcher, the credit meter, Admin for
// platform admins, and the account block. Nav never locks: no entry points at
// /signin and no padlock state exists.

const org = {
  id: "org-1",
  slug: "acme",
  name: "Acme",
  billable_spend_usd: 5,
  credit_granted_usd: 20
} as Org;

function session(overrides: Partial<AppSidebarSession> = {}): AppSidebarSession {
  return {
    orgs: [org],
    currentOrg: org,
    userEmail: "member@example.test",
    showAdminPanel: false,
    ...overrides
  };
}

function render(ui: Parameters<typeof renderBare>[0], isAuthenticated = false) {
  return renderBare(
    <LoginModalProvider isAuthenticated={isAuthenticated}>{ui}</LoginModalProvider>
  );
}

beforeEach(() => {
  nav.pathname = "/models";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The portal tooltip bubbles currently in the document. */
function bubbles(): HTMLElement[] {
  return screen.queryAllByTestId("tooltip-bubble");
}

function bubbleWithText(text: string): HTMLElement | undefined {
  return bubbles().find((bubble) => bubble.textContent?.includes(text));
}

describe("signed-out sidebar", () => {
  it("shows the public nav and footer, none of the member chrome", () => {
    render(<AppSidebar session={null} />);

    expect(screen.getByRole("link", { name: "Models" })).toHaveAttribute("href", "/models");
    // Playground is hidden from the nav (hide-from-nav, page stays live); no link.
    expect(screen.queryByRole("link", { name: "Playground" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Logs" })).toHaveAttribute("href", "/logs");
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: "Credits" })).toHaveAttribute("href", "/credits");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();

    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Projects" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Switch organization")).not.toBeInTheDocument();
    // No credit meter: the meter link carries the remaining balance in its name.
    expect(screen.queryByRole("link", { name: /left$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("never links to /signin and never renders a locked entry", () => {
    const { container } = render(<AppSidebar session={null} />);

    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs.some((href) => href?.startsWith("/signin"))).toBe(false);
    // The retired padlock pattern suffixed labels with "(log in)".
    expect(screen.queryByText(/\(log in\)/)).not.toBeInTheDocument();
  });

  it("opens the login modal in place from the Log in button", () => {
    render(<AppSidebar session={null} />);

    expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
    // In place: a dialog, not a navigation.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the collapsed Log in label visible outside the clipping aside", () => {
    // The collapsed rail is icon-only; the persistent portal Tooltip is what
    // keeps the login affordance findable, and it must live OUTSIDE the aside
    // whose overflow-hidden once clipped it into invisibility.
    const { container } = render(<AppSidebar session={null} initialCollapsed />);

    const label = bubbleWithText("Log in");
    expect(label).toBeDefined();
    expect(container.querySelector("aside")).not.toContainElement(label ?? null);
    expect(document.body).toContainElement(label ?? null);
  });
});

describe("sidebar hover tooltips", () => {
  it("shows the hover card only on the collapsed rail, never expanded", () => {
    // Expanded: the label sits beside the icon, so hovering must NOT pop a
    // tooltip that just echoes it (the product owner, gw-r2: hover info only when collapsed).
    const expanded = render(<AppSidebar session={null} />);
    const modelsExpanded = screen.getByRole("link", { name: "Models" });
    expect(modelsExpanded).not.toHaveAttribute("title");
    fireEvent.mouseEnter(modelsExpanded.parentElement as HTMLElement);
    expect(bubbleWithText("The model catalog, open to explore.")).toBeUndefined();
    expanded.unmount();

    // Collapsed icon-only rail: the portal Tooltip is what makes the item
    // readable, so hovering pops the card with the label and description.
    render(<AppSidebar session={null} initialCollapsed />);
    const models = screen.getByRole("link", { name: "Models" });
    expect(models).not.toHaveAttribute("title");
    expect(bubbleWithText("open to explore")).toBeUndefined();

    fireEvent.mouseEnter(models.parentElement as HTMLElement);
    const bubble = bubbleWithText("The model catalog, open to explore.");
    expect(bubble).toBeDefined();
    expect(bubble?.textContent).toContain("Models");

    fireEvent.mouseLeave(models.parentElement as HTMLElement);
    expect(bubbleWithText("open to explore")).toBeUndefined();
  });
});

describe("signed-in sidebar", () => {
  it("adds Overview, the org switcher, the inline credit amount, and the account block", () => {
    render(<AppSidebar session={session({ showAdminPanel: true })} />, true);

    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/overview");
    expect(screen.getByLabelText("Switch organization")).toBeInTheDocument();
    // The remaining balance ($20 granted − $5 billable) rides the Credits tab
    // inline; the standalone meter that once carried it is gone.
    const credits = screen.getByRole("link", { name: "Credits" });
    expect(credits).toHaveAttribute("href", "/credits");
    expect(credits).toHaveTextContent("$15.00");
    expect(screen.getByRole("button", { name: /Sign out member@example.test/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log in" })).not.toBeInTheDocument();
  });

  it("shows Admin to platform admins only", () => {
    const { unmount } = render(<AppSidebar session={session({ showAdminPanel: true })} />, true);
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
    unmount();

    render(<AppSidebar session={session()} />, true);
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("retires the Projects entry and its count badge", () => {
    render(<AppSidebar session={session()} />, true);

    expect(screen.queryByRole("link", { name: "Projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Simulations" })).not.toBeInTheDocument();
  });

  it("gives API Keys a first-class entry at /api-keys that lights only itself, never Settings", () => {
    nav.pathname = "/api-keys";
    render(<AppSidebar session={session()} />, true);

    const apiKeys = screen.getByRole("link", { name: "API Keys" });
    expect(apiKeys).toHaveAttribute("href", "/api-keys");
    // Active on its own top-level route.
    expect(apiKeys.className).toContain("text-accent");
    // The old /settings/api-keys home lit Settings simultaneously; the top-level
    // route ends that dual-highlight — Settings is not active on /api-keys.
    expect(screen.getByRole("link", { name: "Settings" }).className).not.toContain("text-accent");
    // API keys is no longer a Settings tab either (that's the whole point).
    expect(screen.queryByRole("link", { name: "API keys" })).not.toBeInTheDocument();
  });

  it("labels the /aliases surface 'Access control', never the retired 'Aliases'", () => {
    // The rename (2026-08-23): the entry names the whole page — named aliases
    // plus identities, grants, and budgets — not just its first section.
    render(<AppSidebar session={session()} />, true);

    expect(screen.getByRole("link", { name: "Access control" })).toHaveAttribute(
      "href",
      "/aliases"
    );
    expect(screen.queryByRole("link", { name: "Aliases" })).not.toBeInTheDocument();
  });

  it("hides Access control from signed-out visitors (the page is workspace-private)", () => {
    render(<AppSidebar session={null} />);

    expect(screen.queryByRole("link", { name: "Access control" })).not.toBeInTheDocument();
  });
});
