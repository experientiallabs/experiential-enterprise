import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Opening or switching an org awaits the active-org cookie POST before it can
// navigate, and neither surface acknowledged the click during that wait - on a
// slow connection the click read as ignored and got retried (the product owner,
// 2026-07-30). The card says "Opening…" and disables its siblings; the
// switcher trigger pre-announces the destination org, dimmed.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { OrgsGrid } from "@/components/orgs/OrgsGrid";
import { OrgSwitcher } from "@/components/shell/OrgSwitcher";
import type { Org } from "@/lib/types";

const acme = { id: "org-1", slug: "acme", name: "Acme" } as Org;
const globex = { id: "org-2", slug: "globex", name: "Globex" } as Org;

beforeEach(() => {
  // The cookie POST that never answers: the busy state, frozen.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("org switch feedback", () => {
  it("marks the clicked org card busy and blocks its siblings", () => {
    render(<OrgsGrid orgs={[acme, globex]} />);

    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));

    expect(screen.getByText("Opening…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Acme/ })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /Globex/ })).toBeDisabled();
  });

  it("dims the switcher trigger to the destination org while the cookie write is in flight", async () => {
    render(<OrgSwitcher canManageOrgs currentOrg={acme} orgs={[acme, globex]} />);

    const trigger = screen.getByRole("button", { name: "Switch organization" });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Globex/ }));
    });

    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(trigger).toHaveTextContent("Globex");
  });
});

// Switching soft-navigates and refreshes while the switcher stays mounted, so
// the in-flight latch has to clear when the active org lands — otherwise the
// switcher wedges after one switch and you cannot pick any org again, including
// the one you came from (the product owner, 2026-08-21).
describe("org switcher re-selection after a completed switch", () => {
  it("lets you switch again (back to the previous org) once the switch lands", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <OrgSwitcher canManageOrgs currentOrg={acme} orgs={[acme, globex]} />
    );

    // Switch acme -> globex.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch organization" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Globex/ }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The server refresh lands: the switcher re-renders with globex active,
    // which must release the latch.
    await act(async () => {
      rerender(<OrgSwitcher canManageOrgs currentOrg={globex} orgs={[acme, globex]} />);
    });

    // Now switch back to acme; without the fix the stale latch swallowed this.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch organization" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Acme/ }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/active-org",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ org: "acme" }) })
    );
  });
});

// A portaled fixed-position menu that closes on any background scroll vanishes
// while you are still reading it (the product owner cares about these little interactions).
// It must follow the trigger on scroll/resize and close only on select,
// outside-click, and Escape.
describe("org switcher dropdown open/close", () => {
  async function openMenu() {
    render(<OrgSwitcher canManageOrgs currentOrg={acme} orgs={[acme, globex]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch organization" }));
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  }

  it("stays open when the page scrolls (menu repositions, not closes)", async () => {
    await openMenu();
    await act(async () => {
      fireEvent.scroll(window);
    });
    expect(screen.queryByRole("menu")).toBeInTheDocument();
  });

  it("stays open when scrolling inside the menu", async () => {
    await openMenu();
    await act(async () => {
      fireEvent.scroll(screen.getByRole("menu"));
    });
    expect(screen.queryByRole("menu")).toBeInTheDocument();
  });

  it("closes on select", async () => {
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Globex/ }));
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    await openMenu();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on outside pointerdown", async () => {
    await openMenu();
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
