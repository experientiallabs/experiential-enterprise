import { describe, expect, it, vi } from "vitest";

import { addOrInviteMember } from "@/lib/members/manage";

// The banned-org guard sits inside the shared add-or-invite flow so the org
// Settings surface and the experiential-admin panel cannot drift: a banned
// tenant may not grow, whether the target has an account or not.
describe("addOrInviteMember banned-org guard", () => {
  it("refuses a banned org before any lookup or write", async () => {
    const rpc = vi.fn();
    const filterable = {
      eq: () => filterable,
      maybeSingle: async () => ({ data: { banned_at: "2026-08-29T00:00:00Z" }, error: null })
    };
    const admin = {
      rpc,
      from: (table: string) => {
        expect(table).toBe("organizations");
        return { select: () => filterable };
      }
    };

    const result = await addOrInviteMember(admin as never, {
      orgId: "org-1",
      orgName: "Acme",
      email: "new@acme.com",
      role: "user",
      invitedBy: "operator-1",
      origin: "https://platform.example"
    });

    expect(result).toEqual({
      action: "error",
      status: 403,
      message: "This organization is banned. Members cannot be added or invited."
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
