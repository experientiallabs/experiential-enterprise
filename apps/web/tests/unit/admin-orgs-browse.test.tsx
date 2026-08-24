import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh })
}));

import { OrgsBrowse } from "@/components/admin/OrgsBrowse";
import type { AdministeredOrg } from "@/lib/admin/orgs-server";

const ORGS: AdministeredOrg[] = [
  {
    id: "org-a",
    name: "Alpha Robotics",
    slug: "alpha",
    createdAt: "2026-07-11T00:00:00Z",
    members: [
      {
        userId: "u1",
        email: "founder@alpha.com",
        role: "admin",
        createdAt: "2026-07-11T00:00:00Z",
        isExperientialAdmin: false
      }
    ],
    invites: [],
    ban: null
  },
  {
    id: "org-b",
    name: "Beta Labs",
    slug: "beta",
    createdAt: "2026-08-01T00:00:00Z",
    members: [],
    invites: [],
    ban: null
  }
];

/** Card link order by org name, top to bottom. */
function cardOrder(): string[] {
  return screen.getAllByRole("link").map((link) => link.textContent ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ orgs: [] }), { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrgsBrowse cards", () => {
  it("renders each organization as a card that links to its admin detail page", () => {
    render(<OrgsBrowse orgs={ORGS} />);

    const alpha = screen.getByRole("link", { name: /Alpha Robotics/ });
    const beta = screen.getByRole("link", { name: /Beta Labs/ });
    expect(alpha).toHaveAttribute("href", "/admin/orgs/org-a");
    expect(beta).toHaveAttribute("href", "/admin/orgs/org-b");
    // The card summary carries the slug and member count.
    expect(within(alpha).getByText("alpha")).toBeInTheDocument();
    expect(within(alpha).getByText("1")).toBeInTheDocument();
  });

  it("shows the founding admin's email on the card (and nothing when unknown)", () => {
    render(<OrgsBrowse orgs={ORGS} />);
    const alpha = screen.getByRole("link", { name: /Alpha Robotics/ });
    expect(within(alpha).getByText("founder@alpha.com")).toBeInTheDocument();
    // Beta has no members, so its card carries no identity line beyond the slug.
    const beta = screen.getByRole("link", { name: /Beta Labs/ });
    expect(within(beta).queryByText(/@/)).not.toBeInTheDocument();
  });

  it("defaults to the 7-day spend sort, highest spend first, from the window rollup", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/telemetry/usage")) {
        // org-a spent today; org-b is absent from the rollup and counts as $0.
        return new Response(
          JSON.stringify({
            rows: [{ day: null, org_id: "org-a", alias: null, spend_micro_usd: 5_000_000 }]
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgsBrowse orgs={ORGS} />);
    expect(screen.getByRole("combobox", { name: "Sort organizations" })).toHaveValue(
      "spend"
    );
    // Once the rollup lands, Alpha ($5 today) outranks the newer Beta ($0),
    // and the card shows the day figure beside lifetime usage.
    await waitFor(() => {
      const order = cardOrder();
      expect(order.findIndex((text) => text.includes("Alpha Robotics"))).toBeLessThan(
        order.findIndex((text) => text.includes("Beta Labs"))
      );
    });
    expect(
      within(screen.getByRole("link", { name: /Alpha Robotics/ })).getByText(/7d \$/)
    ).toHaveTextContent("7d $5.00");
  });

  it("breaks spend-today ties on createdAt, newest first", async () => {
    // Empty rollup: every org is $0 today, so the newer Beta sorts first.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/telemetry/usage")) {
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgsBrowse orgs={ORGS} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const order = cardOrder();
    expect(order.findIndex((text) => text.includes("Beta Labs"))).toBeLessThan(
      order.findIndex((text) => text.includes("Alpha Robotics"))
    );
  });

  it("paginates organizations and updates the visible range", () => {
    const paginatedOrgs: AdministeredOrg[] = Array.from({ length: 11 }, (_, index) => {
      const ordinal = String(index + 1).padStart(2, "0");
      return {
        id: `org-${ordinal}`,
        name: `Org ${ordinal}`,
        slug: `org-${ordinal}`,
        createdAt: "2026-08-01T00:00:00Z",
        members: [],
        invites: [],
        ban: null
      };
    });

    render(<OrgsBrowse orgs={paginatedOrgs} />);

    expect(screen.getByRole("link", { name: /Org 01/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Org 11/ })).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1–10 of 11")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.queryByRole("link", { name: /Org 01/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Org 11/ })).toBeInTheDocument();
    expect(screen.getByText("Showing 11–11 of 11")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("filters the cards by a name or slug search", () => {
    render(<OrgsBrowse orgs={ORGS} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search organizations" }), {
      target: { value: "beta" }
    });

    expect(screen.queryByRole("link", { name: /Alpha Robotics/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Beta Labs/ })).toBeInTheDocument();
  });

  it("narrows a status filter to only orgs with the confirmed status", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          orgs: [
            {
              org_id: "org-a",
              spend_usd: 0,
              billable_spend_usd: 0,
              credit_granted_usd: 20,
              credit_balance_usd: 20,
              free_credit_caps_lifted_at: "2026-08-01T00:00:00Z",
              gateway_unknown_cost_attempts: 0
            },
            {
              org_id: "org-b",
              spend_usd: 0,
              billable_spend_usd: 0,
              credit_granted_usd: 20,
              credit_balance_usd: 20,
              free_credit_caps_lifted_at: null,
              gateway_unknown_cost_attempts: 0
            }
          ]
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgsBrowse orgs={ORGS} />);
    // Wait for the bulk usage read to land so statuses are confirmed.
    await screen.findByText("Caps lifted");

    fireEvent.change(screen.getByRole("combobox", { name: "Filter organizations" }), {
      target: { value: "caps-lifted" }
    });

    expect(screen.getByRole("link", { name: /Alpha Robotics/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Beta Labs/ })).not.toBeInTheDocument();
  });

  it("does not match a status filter when usage failed to load", async () => {
    // A failed bulk read must not park every org under a status filter; the
    // filter matches confirmed statuses only, so nothing matches.
    const fetchMock = vi.fn(async () => new Response("nope", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgsBrowse orgs={ORGS} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByRole("combobox", { name: "Filter organizations" }), {
      target: { value: "needs-review" }
    });

    expect(screen.queryByRole("link", { name: /Alpha Robotics/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Beta Labs/ })).not.toBeInTheDocument();
    expect(await screen.findByText("No organizations match your search.")).toBeInTheDocument();
  });

  it("shows a loading state, not a false no-match, while usage is still loading", () => {
    // fetch never resolves: every org's status stays unknown.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<OrgsBrowse orgs={ORGS} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter organizations" }), {
      target: { value: "caps-lifted" }
    });

    expect(screen.getByText("Loading organization usage…")).toBeInTheDocument();
    expect(screen.queryByText("No organizations match your search.")).not.toBeInTheDocument();
  });

  it("opens the Add organization modal and requires both name and founder email", () => {
    render(<OrgsBrowse orgs={ORGS} />);
    // No inline form: the fields exist only behind the modal trigger.
    expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add organization/ }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Founder email")).toBeInTheDocument();
    // Copy must set the expectation that credits stay locked until inbox proof.
    expect(within(dialog).getByText(/stays locked until they verify/)).toBeInTheDocument();
    // Submitting without both fields is refused with an inline error (the
    // ConfirmDialog pattern: validation happens in onConfirm, like the ban
    // dialog) and nothing is posted.
    const submit = within(dialog).getByRole("button", { name: /Create organization/ });
    fireEvent.click(submit);
    expect(
      within(dialog).getByText(/Enter both an organization name and the founder's email/)
    ).toBeInTheDocument();
    const orgPosts = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input) === "/api/admin/orgs");
    expect(orgPosts).toHaveLength(0);
  });

  it("creates an organization with its founder and shows the success state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
      }
      if (url.startsWith("/api/admin/telemetry/usage")) {
        return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      }
      if (url === "/api/admin/orgs") {
        return new Response(
          JSON.stringify({
            organization: { id: "org-9", name: "Gamma", slug: "gamma-1a2b3c4d" },
            founder: { email: "founder@gamma.com", status: "created" },
            verification_email_sent: true
          }),
          { status: 201 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgsBrowse orgs={ORGS} />);
    fireEvent.click(screen.getByRole("button", { name: /Add organization/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Organization name"), {
      target: { value: "Gamma" }
    });
    fireEvent.change(within(dialog).getByLabelText("Founder email"), {
      target: { value: "founder@gamma.com" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create organization/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/orgs",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "Gamma", founder_email: "founder@gamma.com" })
        })
      )
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // Success state: the new org, its founder, the emailed-link confirmation,
    // the locked-credits reminder, and the click-through to the admin detail.
    const successDialog = screen.getByRole("dialog");
    expect(within(successDialog).getByText("Organization created")).toBeInTheDocument();
    expect(within(successDialog).getByText("founder@gamma.com")).toBeInTheDocument();
    expect(
      within(successDialog).getByText(/a verification link was emailed to them/)
    ).toBeInTheDocument();
    expect(
      within(successDialog).getByText(/Credits stay locked until they verify/)
    ).toBeInTheDocument();
    fireEvent.click(within(successDialog).getByRole("button", { name: "Manage organization" }));
    expect(push).toHaveBeenCalledWith("/admin/orgs/org-9");
  });

  it("tells the admin when the verification email could not be sent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/orgs") {
        return new Response(
          JSON.stringify({
            organization: { id: "org-9", name: "Gamma", slug: "gamma-1a2b3c4d" },
            founder: { email: "founder@gamma.com", status: "existing" },
            verification_email_sent: false
          }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify({ orgs: [], rows: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgsBrowse orgs={ORGS} />);
    fireEvent.click(screen.getByRole("button", { name: /Add organization/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Organization name"), {
      target: { value: "Gamma" }
    });
    fireEvent.change(within(dialog).getByLabelText("Founder email"), {
      target: { value: "founder@gamma.com" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create organization/ }));

    // The success copy must not claim an email that never went out.
    expect(
      await screen.findByText(/sign-in email could not be sent/)
    ).toBeInTheDocument();
  });

  it("resets the dialog when reopened after a create", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/orgs") {
        return new Response(
          JSON.stringify({
            organization: { id: "org-9", name: "Gamma", slug: "gamma-1a2b3c4d" },
            founder: { email: "founder@gamma.com", status: "created" },
            verification_email_sent: true
          }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify({ orgs: [], rows: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgsBrowse orgs={ORGS} />);
    fireEvent.click(screen.getByRole("button", { name: /Add organization/ }));
    let dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Organization name"), {
      target: { value: "Gamma" }
    });
    fireEvent.change(within(dialog).getByLabelText("Founder email"), {
      target: { value: "founder@gamma.com" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create organization/ }));
    await screen.findByText("Organization created");

    // Dismiss the success step, reopen: the modal unmounts on close, so the
    // form comes back fresh instead of the stale success view.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add organization/ }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Add organization")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Organization name")).toHaveValue("");
  });

  it("surfaces a create failure inside the modal", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/orgs") {
        return new Response(JSON.stringify({ error: "The founder email is not a valid address." }), {
          status: 400
        });
      }
      return new Response(JSON.stringify({ orgs: [], rows: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgsBrowse orgs={ORGS} />);
    fireEvent.click(screen.getByRole("button", { name: /Add organization/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Organization name"), {
      target: { value: "Gamma" }
    });
    fireEvent.change(within(dialog).getByLabelText("Founder email"), {
      target: { value: "founder@gamma" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create organization/ }));

    expect(
      await within(dialog).findByText("The founder email is not a valid address.")
    ).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("OrgsBrowse ban badge", () => {
  it("marks a banned tenant's card with a danger badge", () => {
    render(
      <OrgsBrowse
        orgs={[
          ORGS[0],
          {
            ...ORGS[1],
            ban: {
              reason: "Coordinated credit abuse",
              bannedBy: "op-1",
              bannedByEmail: "operator@example.com",
              bannedAt: "2026-08-29T00:00:00Z"
            }
          }
        ]}
      />
    );

    const bannedCard = screen.getByRole("link", { name: /Beta Labs/ });
    expect(bannedCard).toHaveTextContent("Banned");
    expect(screen.getByRole("link", { name: /Alpha Robotics/ })).not.toHaveTextContent("Banned");
  });
});
