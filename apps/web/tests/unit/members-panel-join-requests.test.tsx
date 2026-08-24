import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MembersPanel } from "@/components/settings/MembersPanel";
import type { PendingJoinRequest } from "@/lib/org-join/types";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() })
}));

const ORG_ID = "org-uuid";
const REQUEST: PendingJoinRequest = {
  id: "req-1",
  user_id: "user-1",
  email: "dev@acme.com",
  created_at: "2026-08-21T00:00:00Z"
};

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function renderPanel() {
  render(
    <MembersPanel
      canManage
      currentUserId="admin-1"
      invites={[]}
      joinRequests={[REQUEST]}
      members={[]}
      orgId={ORG_ID}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("MembersPanel access requests", () => {
  it("approves a request through the BFF and refreshes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "req-1", status: "approved" })
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === `/api/orgs/${ORG_ID}/join-requests/${REQUEST.id}/approve` &&
            (init as RequestInit | undefined)?.method === "POST"
        )
      ).toBe(true);
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("refreshes on a 409 so a request decided by another admin stops being actionable", async () => {
    // The race Greptile flagged: the backend returns 409 because the request is
    // no longer pending. Without a refresh the stale row would linger as
    // actionable; the fix re-fetches so it disappears.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ error: "Join request already denied." }, false, 409)
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.getByText("Join request already denied.")).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
  });
});

describe("MembersPanel account-actions slot", () => {
  const MEMBER = {
    userId: "member-1",
    email: "member@acme.com",
    role: "user",
    createdAt: "2026-08-01T00:00:00Z",
    isExperientialAdmin: false
  };

  it("locks the panel's own member actions while the slot reports a mutation in flight", () => {
    render(
      <MembersPanel
        canManage
        currentUserId="admin-1"
        invites={[]}
        joinRequests={[]}
        members={[MEMBER]}
        orgId={ORG_ID}
        renderAccountActions={(member, controls) => (
          <button
            onClick={() => controls.onBusyChange(true)}
            type="button"
          >
            {`Slot for ${member.email}${controls.disabled ? " (locked)" : ""}`}
          </button>
        )}
      />
    );

    // The slot renders per member and starts unlocked.
    const slot = screen.getByRole("button", { name: "Slot for member@acme.com" });
    expect(screen.getByRole("button", { name: "Remove" })).not.toBeDisabled();

    // The slot reports busy: the panel's Remove (and role select) lock, so a
    // remove-from-org cannot race the slot's delete-account on this member.
    fireEvent.click(slot);
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Role for member@acme.com" })).toBeDisabled();
  });
});
