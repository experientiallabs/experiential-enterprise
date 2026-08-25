import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() })
}));

import { EnterpriseBrowse } from "@/components/admin/EnterpriseBrowse";

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: true, json: async () => ({ org_id: "org-1", entitlements: [] }) }))
);

const ORGS = [
  { id: "org-1", slug: "acme", name: "Acme Inc" },
  { id: "org-2", slug: "globex", name: "Globex" }
];

describe("EnterpriseBrowse", () => {
  it("shows the empty state when no org holds a grant", () => {
    render(<EnterpriseBrowse grants={[]} orgs={ORGS} />);
    expect(screen.getByText(/No organization holds an enterprise grant/)).toBeInTheDocument();
  });

  it("finds an org by slug and mounts its entitlement editor", async () => {
    render(<EnterpriseBrowse grants={[]} orgs={ORGS} />);
    fireEvent.change(screen.getByLabelText("Search organizations"), {
      target: { value: "acme" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Acme Inc/ }));
    expect(await screen.findByText("Enterprise entitlements")).toBeInTheDocument();
  });

  it("lists current grants grouped by org with expired rows struck through", () => {
    render(
      <EnterpriseBrowse
        grants={[
          {
            org_id: "org-2",
            org_slug: "globex",
            org_name: "Globex",
            capability: "teams",
            granted_by: null,
            note: null,
            created_at: null,
            expires_at: null
          },
          {
            org_id: "org-2",
            org_slug: "globex",
            org_name: "Globex",
            capability: "sso",
            granted_by: null,
            note: null,
            created_at: null,
            expires_at: "2020-01-01T00:00:00Z"
          }
        ]}
        orgs={ORGS}
      />
    );
    expect(screen.getByRole("button", { name: "Globex" })).toBeInTheDocument();
    expect(screen.getByText("Teams")).toBeInTheDocument();
    expect(screen.getByText(/Domains & SSO/).className).toContain("line-through");
  });

  it("refreshes the route after a grant so the summary cannot go stale", async () => {
    refresh.mockClear();
    render(<EnterpriseBrowse grants={[]} orgs={ORGS} />);
    fireEvent.change(screen.getByLabelText("Search organizations"), {
      target: { value: "acme" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Acme Inc/ }));
    const grant = (await screen.findAllByRole("button", { name: "Grant" }))[0];
    fireEvent.click(grant);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
