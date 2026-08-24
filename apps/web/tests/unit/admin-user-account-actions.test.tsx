import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

import { UserAccountActions, type UserAccountTarget } from "@/components/admin/UserAccountActions";

const CUSTOMER: UserAccountTarget = {
  id: "user-1",
  email: "customer@example.com",
  banned: false,
  isExperientialAdmin: false
};

function renderActions(user: Partial<UserAccountTarget> = {}, currentUserId = "operator-1") {
  render(<UserAccountActions currentUserId={currentUserId} user={{ ...CUSTOMER, ...user }} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UserAccountActions email edit", () => {
  it("changes the email through the admin route and tells the operator no email is sent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/admin/users/user-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ email: "renamed@example.com" });
      return new Response(JSON.stringify({ userId: "user-1", email: "renamed@example.com" }), {
        status: 200
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Edit email" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "No confirmation email is sent to the old or the new address."
    );

    const input = screen.getByRole("textbox", { name: "New email address" });
    // The current address prefills so a typo edit starts from the truth.
    expect(input).toHaveValue("customer@example.com");
    fireEvent.change(input, { target: { value: " Renamed@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Save email" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses a malformed address without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Edit email" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "New email address" }), {
      target: { value: "not-an-email" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save email" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate-address refusal inside the dialog", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Email address already registered by another user" }), {
          status: 409
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Edit email" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "New email address" }), {
      target: { value: "taken@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save email" }));

    expect(
      await screen.findByText("Email address already registered by another user")
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

const SECRET = "xpladmin_" + "c".repeat(40);

describe("UserAccountActions experiential-admin toggle", () => {
  it("grants after confirming and reveals the freshly minted superadmin key once", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/admin/users/user-1/site-admin");
      expect(init?.method).toBe("PUT");
      return new Response(
        JSON.stringify({
          userId: "user-1",
          siteAdmin: true,
          key: { name: "granted 2026-08-23", secret: SECRET }
        }),
        { status: 200 }
      );
    });
    const writeText = vi.fn(async () => {});
    // jsdom has no clipboard; graft one onto the real navigator rather than
    // replacing the global (React reads other navigator fields).
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Make experiential admin" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Make customer@example.com an experiential admin?");
    expect(dialog).toHaveTextContent("superadmin API key is minted");
    fireEvent.click(within(dialog).getByRole("button", { name: "Grant access" }));

    // The one-time reveal: secret on screen with a copy button, gone after Done.
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy superadmin key" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(SECRET)).toBeNull();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("re-granting an existing admin reveals nothing when no key was minted", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ userId: "user-1", siteAdmin: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Make experiential admin" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Grant access" })
    );

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("surfaces a grant-side mint failure without hiding the applied grant", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            userId: "user-1",
            siteAdmin: true,
            mintError: "The grant succeeded but no key was minted (insert refused). Revoke and re-grant to mint one."
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Make experiential admin" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Grant access" })
    );

    expect(await screen.findByText(/no key was minted/)).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("revokes after confirming a dialog that warns about the superadmin-key kill switch", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/admin/users/user-1/site-admin");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderActions({ isExperientialAdmin: true });

    fireEvent.click(screen.getByRole("button", { name: "Revoke experiential admin" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Their superadmin API keys stop working immediately");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke access" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("does nothing when the confirm dialog is dismissed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Make experiential admin" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables self-revocation with the lockout explanation", () => {
    renderActions({ id: "operator-1", email: "operator@example.com", isExperientialAdmin: true }, "operator-1");

    expect(screen.getByRole("button", { name: "Revoke experiential admin" })).toBeDisabled();
    expect(
      screen.getByText("You cannot revoke your own access. Another operator must do it.")
    ).toBeInTheDocument();
  });

  it("offers no grant on a banned row: the route would mint a working credential", () => {
    renderActions({ banned: true });

    expect(screen.queryByRole("button", { name: "Make experiential admin" })).toBeNull();
    expect(screen.getByRole("button", { name: "Unban" })).toBeInTheDocument();
  });

  it("warns that the key may exist when the grant request dies mid-flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Make experiential admin" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Grant access" })
    );

    expect(
      await screen.findByText(/The grant may have applied and a key been minted/)
    ).toBeInTheDocument();
    // The refresh still runs so a silently applied grant becomes visible.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("UserAccountActions ban and delete", () => {
  it("bans with a required reason through the confirm dialog", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/admin/users/user-1/ban");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ reason: "Fraudulent gateway usage" });
      return new Response(JSON.stringify({ userId: "user-1", banned: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Ban" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ban account" }));
    expect(await screen.findByText("A reason is required to ban an account.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "Ban reason" }), {
      target: { value: "Fraudulent gateway usage" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Ban account" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("unbans a banned account after confirming a dialog that notes revoked keys stay revoked", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/admin/users/user-1/ban");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderActions({ banned: true });

    fireEvent.click(screen.getByRole("button", { name: "Unban" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("API keys revoked at ban time stay revoked.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unban account" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("surfaces an unknown outcome when a confirmed action dies mid-flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete account" })
    );

    expect(
      await screen.findByText(/it may not have been applied. Refresh and retry./)
    ).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("deletes the account after confirming and surfaces a refusal inline", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/admin/users/user-1");
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ error: "GoTrue is down." }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete the account customer@example.com");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));

    expect(await screen.findByText("GoTrue is down.")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers neither ban nor delete on the operator's own row", () => {
    renderActions({ id: "operator-1", email: "operator@example.com" }, "operator-1");

    expect(screen.queryByRole("button", { name: "Ban" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit email" })).toBeInTheDocument();
  });
});
