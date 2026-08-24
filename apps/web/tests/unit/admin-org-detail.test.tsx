import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh })
}));

import { OrgAdminDetail } from "@/components/admin/OrgAdminDetail";

const ORG = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
  createdAt: "2026-07-11T00:00:00Z",
  members: [],
  invites: [],
  ban: null,
  welcomeTrigger: null
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrgAdminDetail usage refresh", () => {
  it("bypasses the browser cache when loading live organization spend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orgs: [{ org_id: "org-1", spend_usd: 1.25 }] })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAdminDetail currentUserId="admin-user" org={ORG} />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/orgs/usage", { cache: "no-store" })
    );
  });
});

describe("OrgAdminDetail free-credit caps", () => {
  it("lifts the caps through the admin endpoint and reflects the lifted state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(
          JSON.stringify({
            orgs: [
              {
                org_id: "org-1",
                spend_usd: 0,
                billable_spend_usd: 0,
                credit_granted_usd: 20,
                credit_balance_usd: 20,
                free_credit_caps_lifted_at: null,
                gateway_unknown_cost_attempts: 2
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url === "/api/admin/orgs/org-1/free-credit-caps") {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({ lifted: true });
        return new Response(
          JSON.stringify({ free_credit_caps_lifted_at: "2026-08-19T00:00:00Z" }),
          { status: 200 }
        );
      }
      if (url.includes("/labels") || url.includes("/notes")) {
        return new Response(JSON.stringify({ labels: [], notes: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAdminDetail currentUserId="admin-user" org={ORG} />);

    // The unknown-cost review signal renders once the bulk read lands.
    expect(await screen.findByText(/2 gateway attempts billed \$0/i)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Lift free-credit caps" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/orgs/org-1/free-credit-caps",
        expect.objectContaining({ method: "PUT" })
      )
    );
    expect(await screen.findByText(/free-credit daily caps lifted/i)).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("OrgAdminDetail open org", () => {
  it("sets the org active and navigates to its workspace on Open", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
      }
      if (url === "/api/active-org") {
        return new Response(JSON.stringify({ ok: true, org: "acme" }), { status: 200 });
      }
      if (url.includes("/labels") || url.includes("/notes")) {
        return new Response(JSON.stringify({ labels: [], notes: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAdminDetail currentUserId="admin-user" org={ORG} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/active-org", {
        body: JSON.stringify({ org: "acme" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/overview"));
  });

  it("surfaces a refusal without navigating", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
      }
      if (url === "/api/active-org") {
        return new Response(JSON.stringify({}), { status: 500 });
      }
      if (url.includes("/labels") || url.includes("/notes")) {
        return new Response(JSON.stringify({ labels: [], notes: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAdminDetail currentUserId="admin-user" org={ORG} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));

    expect(await screen.findByText(/unable to open "acme"/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("clears the busy latch when the request rejects at the network level", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
      }
      if (url === "/api/active-org") {
        throw new Error("network down");
      }
      if (url.includes("/labels") || url.includes("/notes")) {
        return new Response(JSON.stringify({ labels: [], notes: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAdminDetail currentUserId="admin-user" org={ORG} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open/ }));

    expect(await screen.findByText(/unable to open "acme"/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    // The latch cleared, so the Open control is interactive again.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Open/ })).not.toBeDisabled());
  });
});

describe("OrgAdminDetail member invitations", () => {
  it("shows a copyable signup link when invite email delivery fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
      }
      // Admin member management runs through the same org-scoped route the
      // settings surface uses; experiential admins pass its gate.
      if (url === "/api/orgs/org-1/members") {
        return new Response(
          JSON.stringify({
            action: "invited",
            email: { sent: false, reason: "Resend is not configured" },
            inviteUrl: "https://platform.example/signin?invite=invite-token"
          }),
          { status: 201 }
        );
      }
      if (url.includes("/labels") || url.includes("/notes")) {
        return new Response(JSON.stringify({ labels: [], notes: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAdminDetail currentUserId="admin-user" org={ORG} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "new@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    expect(await screen.findByText(/email to new@example.com was not sent/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Signup link for new@example.com")).toHaveValue(
      "https://platform.example/signin?invite=invite-token"
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("OrgAdminDetail account actions parity", () => {
  const MEMBER_ORG = {
    ...ORG,
    members: [
      {
        userId: "member-1",
        email: "member@acme.com",
        role: "user",
        createdAt: "2026-07-12T00:00:00Z",
        isExperientialAdmin: false,
        banned: false
      },
      {
        userId: "banned-1",
        email: "banned@acme.com",
        role: "user",
        createdAt: "2026-07-13T00:00:00Z",
        isExperientialAdmin: false,
        banned: true
      }
    ]
  };

  it("offers the same user-scoped account actions as the admin Users page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ orgs: [] }), { status: 200 }))
    );

    render(<OrgAdminDetail currentUserId="admin-user" org={MEMBER_ORG} />);

    // Two rows, each with the shared actions; the banned row flips to Unban
    // and offers no admin grant (the route refuses banned accounts).
    expect(screen.getAllByRole("button", { name: "Edit email" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Make experiential admin" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Ban" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unban" })).toBeInTheDocument();
    // The org-scoped removal stays alongside them.
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  });

  it("bans a member from the org surface through the shared admin route", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
      }
      if (url === "/api/admin/users/member-1/ban") {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({ reason: "Abuse" });
        return new Response(JSON.stringify({ userId: "member-1", banned: true }), { status: 200 });
      }
      if (url.includes("/labels") || url.includes("/notes")) {
        return new Response(JSON.stringify({ labels: [], notes: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAdminDetail currentUserId="admin-user" org={MEMBER_ORG} />);

    fireEvent.click(screen.getByRole("button", { name: "Ban" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Ban reason" }), {
      target: { value: "Abuse" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Ban account" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/users/member-1/ban",
        expect.objectContaining({ method: "PUT" })
      )
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("OrgAdminDetail header identity", () => {
  it("shows the founding admin's email beside the slug", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ orgs: [] }), { status: 200 }))
    );
    render(
      <OrgAdminDetail
        currentUserId="admin-user"
        org={{
          ...ORG,
          members: [
            {
              userId: "u2",
              email: "later@acme.com",
              role: "admin",
              createdAt: "2026-07-20T00:00:00Z",
              isExperientialAdmin: false,
              banned: false
            },
            {
              userId: "u1",
              email: "founder@acme.com",
              role: "admin",
              createdAt: "2026-07-11T00:00:00Z",
              isExperientialAdmin: false,
              banned: false
            }
          ]
        }}
      />
    );
    expect(screen.getByText(/acme · 2 members · founder@acme\.com/)).toBeInTheDocument();
  });
});

describe("OrgAdminDetail org ban", () => {
  it("bans with a required reason through the confirm dialog", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
      }
      if (url === "/api/admin/orgs/org-1/ban") {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({ reason: "Coordinated credit abuse" });
        return new Response(JSON.stringify({ orgId: "org-1", banned: true }), { status: 200 });
      }
      if (url.includes("/labels") || url.includes("/notes")) {
        return new Response(JSON.stringify({ labels: [], notes: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OrgAdminDetail currentUserId="admin-user" org={ORG} />);

    fireEvent.click(screen.getByRole("button", { name: "Ban organization" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Ban "Acme"?');
    // The dialog copy owns the honesty: keys and invites never come back.
    expect(dialog).toHaveTextContent(/never un-revokes keys or invites/);

    // Confirming without a reason refuses and never calls the ban endpoint.
    fireEvent.click(screen.getByRole("button", { name: "Confirm ban" }));
    expect(
      await screen.findByText("A reason is required to ban an organization.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/orgs/org-1/ban",
      expect.anything()
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Organization ban reason" }), {
      target: { value: "Coordinated credit abuse" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm ban" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/orgs/org-1/ban",
        expect.objectContaining({ method: "PUT" })
      )
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the banned state and unbans through the confirm dialog", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/orgs/usage") {
        return new Response(JSON.stringify({ orgs: [] }), { status: 200 });
      }
      if (url === "/api/admin/orgs/org-1/ban") {
        expect(init?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      }
      if (url.includes("/labels") || url.includes("/notes")) {
        return new Response(JSON.stringify({ labels: [], notes: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OrgAdminDetail
        currentUserId="admin-user"
        org={{
          ...ORG,
          ban: {
            reason: "Coordinated credit abuse",
            bannedBy: "op-1",
            bannedByEmail: "operator@example.com",
            bannedAt: "2026-08-29T00:00:00Z"
          }
        }}
      />
    );

    expect(screen.getByText("Banned")).toBeInTheDocument();
    expect(screen.getByText(/Coordinated credit abuse/)).toBeInTheDocument();
    expect(screen.getByText(/banned by operator@example.com/)).toBeInTheDocument();

    // Canceling the dialog fires nothing.
    fireEvent.click(screen.getByRole("button", { name: "Unban organization" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Unban "Acme"?');
    // The dialog copy owns the honesty: revocation is one-way, and members in
    // another banned org stay banned.
    expect(dialog).toHaveTextContent(/stay revoked/);
    expect(dialog).toHaveTextContent(/another banned organization/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/orgs/org-1/ban",
      expect.anything()
    );

    fireEvent.click(screen.getByRole("button", { name: "Unban organization" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm unban" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/orgs/org-1/ban",
        expect.objectContaining({ method: "DELETE" })
      )
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("welcome celebration card seeds from persisted state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ orgs: [] }) })
    );
  });

  it("shows a never-armed org as disarmed with a blank amount", () => {
    render(<OrgAdminDetail currentUserId="admin-user" org={ORG} />);

    expect((screen.getByLabelText("Credits to show (USD)") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Current state:/).textContent).toContain("disarmed");
  });

  it("seeds the amount, key flag, and armed state from the org's trigger", () => {
    render(
      <OrgAdminDetail
        currentUserId="admin-user"
        org={{
          ...ORG,
          welcomeTrigger: {
            org_id: "org-1",
            active: true,
            display_credit_usd: 526,
            show_api_key: false,
            triggered_at: "2026-08-24T00:00:00Z"
          }
        }}
      />
    );

    expect((screen.getByLabelText("Credits to show (USD)") as HTMLInputElement).value).toBe("526");
    expect((screen.getByLabelText("Show API key") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Current state:/).textContent).toContain("armed");
  });
});
