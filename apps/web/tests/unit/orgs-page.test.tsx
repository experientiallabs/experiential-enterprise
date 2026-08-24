import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/orgs",
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => new URLSearchParams()
}));

// The animated canvas backdrop is irrelevant to grid behavior; stub it out.
vi.mock("@/components/onboarding/ContributionGrid", () => ({
  ContributionGrid: () => <div data-testid="contribution-grid" />
}));

import { OrgsGrid } from "@/components/orgs/OrgsGrid";
import { OrgSwitcher } from "@/components/shell/OrgSwitcher";
import { makeOrg } from "./fixtures";

const orgs = [
  makeOrg({ id: "org-a", slug: "alpha", name: "Alpha" }),
  makeOrg({ id: "org-b", slug: "beta", name: "Beta" })
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  push.mockClear();
  refresh.mockClear();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrgsGrid", () => {
  it("opens an organization's workspace by writing the active org then landing on the Overview", async () => {
    render(<OrgsGrid orgs={orgs} />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("2 total")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/active-org",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ org: "alpha" }) })
      )
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/overview"));
  });

  it("offers no organization-creation affordance to members", () => {
    // Creation is an operator move (the product owner, 2026-08-01); the backend's
    // admin-gated route would refuse anyway, so nothing renders.
    render(<OrgsGrid orgs={orgs} />);

    expect(screen.queryByText(/New organization/)).not.toBeInTheDocument();
  });

  it("lets a platform admin create an organization with its founder email", async () => {
    render(<OrgsGrid canCreate orgs={orgs} />);

    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "acme-support" }
    });
    // The founder email is REQUIRED on every org-create surface: without it
    // the submit stays disabled and nothing is posted.
    const submit = screen.getByRole("button", { name: "Create organization" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Founder email"), {
      target: { value: "founder@acme.com" }
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/orgs",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "acme-support", founder_email: "founder@acme.com" })
        })
      )
    );
    // The refreshed server payload carries the new org into the grid.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("explains provisioning when there are no organizations", () => {
    render(<OrgsGrid orgs={[]} />);

    expect(screen.getByText("No organizations yet")).toBeInTheDocument();
    expect(screen.getByText(/organization invitation/)).toBeInTheDocument();
  });
});

describe("OrgSwitcher", () => {
  it("portals the menu to document.body so the sidebar cannot clip it", () => {
    const { container } = render(<OrgSwitcher canManageOrgs currentOrg={orgs[0]} orgs={orgs} />);

    fireEvent.click(screen.getByRole("button", { name: "Switch organization" }));

    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    // The menu lives outside the component subtree (portal target: body).
    expect(container.contains(menu)).toBe(false);
  });

  it("gives an operator all-organizations and creation entries; the tour replay is gone", () => {
    render(<OrgSwitcher canManageOrgs currentOrg={orgs[0]} orgs={orgs} />);

    fireEvent.click(screen.getByRole("button", { name: "Switch organization" }));
    expect(screen.queryByRole("menuitem", { name: /Replay the tour/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /New organization/ }));
    expect(push).toHaveBeenCalledWith("/orgs?create=1");

    fireEvent.click(screen.getByRole("button", { name: "Switch organization" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /All organizations/ }));
    expect(push).toHaveBeenCalledWith("/orgs");
  });

  it("renders a single-org member's org as a plain label: nothing to switch to", () => {
    render(<OrgSwitcher canManageOrgs={false} currentOrg={orgs[0]} orgs={[orgs[0]]} />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch organization" })).not.toBeInTheDocument();
  });

  it("lets a multi-org member switch between their orgs, without the create entry", async () => {
    // Switching is for any member of more than one org (enterprise
    // build-out); creating organizations stays an operator move.
    render(<OrgSwitcher canManageOrgs={false} currentOrg={orgs[0]} orgs={orgs} />);

    fireEvent.click(screen.getByRole("button", { name: "Switch organization" }));
    expect(screen.getByRole("menuitem", { name: /Beta/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /All organizations/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /New organization/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Beta/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/active-org",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ org: "beta" }) })
      )
    );
  });

  it("switches the active org then lands on the workspace root when a menu item is clicked", async () => {
    render(<OrgSwitcher canManageOrgs currentOrg={orgs[0]} orgs={orgs} />);

    fireEvent.click(screen.getByRole("button", { name: "Switch organization" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Beta/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/active-org",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ org: "beta" }) })
      )
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/models"));
  });
});
