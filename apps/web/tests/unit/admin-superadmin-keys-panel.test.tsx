import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() })
}));

import { SuperadminKeysPanel } from "@/components/admin/SuperadminKeysPanel";
import type { SuperadminKeyRow } from "@/lib/admin/superadmin-keys";

const KEYS: SuperadminKeyRow[] = [
  {
    id: "key-1",
    owner_email: "ops@x.com",
    user_id: "admin-user-1",
    name: "ops bot",
    key_prefix: "xpladmin_ab12cd34",
    key_suffix: "f2e1",
    created_at: "2026-08-20T00:00:00Z",
    last_used_at: "2026-08-22T00:00:00Z",
    revoked_at: null
  },
  {
    id: "key-2",
    owner_email: "ops2@x.com",
    user_id: "admin-user-2",
    name: "old bot",
    // Minted before key_suffix existed: renders prefix-only, no fake tail.
    key_suffix: null,
    key_prefix: "xpladmin_99887766",
    created_at: "2026-08-01T00:00:00Z",
    last_used_at: null,
    revoked_at: "2026-08-10T00:00:00Z"
  }
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SuperadminKeysPanel", () => {
  it("lists keys with prefix, owner email, and revoked state; no revoke on dead rows", () => {
    render(<SuperadminKeysPanel keys={KEYS} />);
    // Prefix plus stored last-4 tail; a pre-suffix key renders prefix-only.
    expect(screen.getByText("xpladmin_ab12cd34…f2e1")).toBeInTheDocument();
    expect(screen.getByText("xpladmin_99887766…")).toBeInTheDocument();
    expect(screen.getByText("ops@x.com")).toBeInTheDocument();
    expect(screen.getByText("ops2@x.com")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    // Only the live key offers Revoke.
    expect(screen.getAllByRole("button", { name: /Revoke/ })).toHaveLength(1);
  });

  it("offers no mint form: keys are created only at superadmin grant", () => {
    render(<SuperadminKeysPanel keys={[]} />);
    expect(screen.queryByLabelText("Key name")).toBeNull();
    expect(screen.queryByRole("button", { name: /Mint key/ })).toBeNull();
    expect(
      screen.getByText(/A key is minted when an operator is granted superadmin status/)
    ).toBeInTheDocument();
  });

  it("revokes a live key only after confirming the dialog", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SuperadminKeysPanel keys={KEYS} />);

    // Open then dismiss: nothing fetched.
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Machine callers using it stop authenticating immediately.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();

    // Confirm: DELETE keyed on the id.
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke key" })
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/superadmin-keys/key-1", { method: "DELETE" });
  });
});
