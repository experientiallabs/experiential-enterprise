import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

import { UsersBrowse } from "@/components/admin/UsersBrowse";
import type { AdministeredUser } from "@/lib/admin/users-server";

const OPERATOR: AdministeredUser = {
  id: "operator-1",
  email: "operator@example.com",
  createdAt: "2026-08-01T10:00:00Z",
  lastSignInAt: "2026-08-28T09:00:00Z",
  orgs: [{ id: "org-1", name: "Acme Robotics" }],
  isExperientialAdmin: true,
  ban: null
};

const CUSTOMER: AdministeredUser = {
  id: "user-1",
  email: "customer@example.com",
  createdAt: "2026-08-10T10:00:00Z",
  lastSignInAt: null,
  orgs: [{ id: "org-2", name: "Beta Corp" }],
  isExperientialAdmin: false,
  ban: null
};

const BANNED: AdministeredUser = {
  id: "user-2",
  email: "banned@example.com",
  createdAt: "2026-08-12T10:00:00Z",
  lastSignInAt: "2026-08-20T09:00:00Z",
  orgs: [],
  isExperientialAdmin: false,
  ban: {
    reason: "Chargeback abuse",
    bannedBy: "operator-1",
    bannedByEmail: "operator@example.com",
    bannedAt: "2026-08-21T09:00:00Z"
  }
};

function renderPanel(users: AdministeredUser[] = [OPERATOR, CUSTOMER, BANNED]) {
  render(<UsersBrowse users={users} currentUserId="operator-1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UsersBrowse", () => {
  it("lists accounts with orgs, sign-in state, and a BANNED badge with provenance", () => {
    renderPanel();

    expect(screen.getByText("customer@example.com")).toBeInTheDocument();
    expect(screen.getByText("Beta Corp")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    expect(screen.getByText("Banned")).toBeInTheDocument();
    expect(screen.getByText("Chargeback abuse")).toBeInTheDocument();
    expect(screen.getByText(/by operator@example.com/)).toBeInTheDocument();
    // The operator's own row offers no ban action.
    expect(screen.getByText("you")).toBeInTheDocument();
    // One bannable row, one banned row.
    expect(screen.getAllByRole("button", { name: "Ban" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Unban" })).toHaveLength(1);
  });

  it("links each membership to that organization's admin detail", () => {
    renderPanel();

    expect(screen.getByRole("link", { name: "Beta Corp" })).toHaveAttribute(
      "href",
      "/admin/orgs/org-2"
    );
  });

  it("offers every user-scoped account action on a customer row", () => {
    renderPanel([CUSTOMER]);

    expect(screen.getByRole("button", { name: "Edit email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make experiential admin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ban" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("badges experiential admins and locks self-revocation with the lockout copy", () => {
    renderPanel();

    expect(screen.getByText("experiential admin")).toBeInTheDocument();
    // The operator's own row: revoke is disabled, ban and delete are absent.
    const selfRevoke = screen.getByRole("button", { name: "Revoke experiential admin" });
    expect(selfRevoke).toBeDisabled();
    expect(
      screen.getByText("You cannot revoke your own access. Another operator must do it.")
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
  });

  it("filters to experiential admins", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("combobox", { name: "Filter users" }), {
      target: { value: "admins" }
    });

    expect(screen.getByText("operator@example.com")).toBeInTheDocument();
    expect(screen.queryByText("customer@example.com")).toBeNull();
  });

  it("filters to banned accounts", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("combobox", { name: "Filter users" }), {
      target: { value: "banned" }
    });

    expect(screen.getByText("banned@example.com")).toBeInTheDocument();
    expect(screen.queryByText("customer@example.com")).toBeNull();
  });

  it("bans with a required reason through the confirm dialog", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/users/user-1/ban") {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toEqual({ reason: "Fraudulent gateway usage" });
        return new Response(JSON.stringify({ userId: "user-1", banned: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Ban" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Ban customer@example.com?");

    // Confirming without a reason refuses and never fetches.
    fireEvent.click(screen.getByRole("button", { name: "Ban account" }));
    expect(await screen.findByText("A reason is required to ban an account.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "Ban reason" }), {
      target: { value: "Fraudulent gateway usage" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Ban account" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("surfaces a ban failure inside the dialog", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "GoTrue is down." }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Ban" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Ban reason" }), {
      target: { value: "Fraud" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Ban account" }));

    expect(await screen.findByText("GoTrue is down.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("unbans after confirming the dialog", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/users/user-2/ban") {
        expect(init?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Unban" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Unban account" })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("does not unban when the confirm dialog is dismissed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Unban" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" })
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
