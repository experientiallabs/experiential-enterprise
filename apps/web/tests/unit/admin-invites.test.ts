import { describe, expect, it } from "vitest";

import { inviteStatus, parseInvitePayload } from "@/lib/admin/invites";

const ORG_ID = "00000000-0000-0000-0000-000000000001";

describe("parseInvitePayload", () => {
  it("accepts a valid payload and lowercases the email", () => {
    const payload = parseInvitePayload({
      email: "  Invited.Person@Example.com ",
      orgId: ORG_ID,
      role: "user"
    });
    expect(payload).toEqual({
      email: "invited.person@example.com",
      orgId: ORG_ID,
      role: "user"
    });
  });

  it("rejects invalid emails", () => {
    expect(() => parseInvitePayload({ email: "not-an-email", orgId: ORG_ID, role: "user" }))
      .toThrowError(/valid email/i);
  });

  it("rejects non-uuid organization ids", () => {
    expect(() => parseInvitePayload({ email: "a@b.co", orgId: "demo", role: "user" }))
      .toThrowError(/organization/i);
  });

  it("rejects roles outside the invitable set", () => {
    // 'owner' is not a role; the ladder tops out at admin.
    expect(() => parseInvitePayload({ email: "a@b.co", orgId: ORG_ID, role: "owner" })).toThrow();
  });
});

describe("inviteStatus", () => {
  const now = new Date("2026-07-07T12:00:00Z");

  it("is accepted once the invite provisioned an account", () => {
    expect(
      inviteStatus({ acceptedAt: "2026-07-06T00:00:00Z", expiresAt: "2026-07-01T00:00:00Z" }, now)
    ).toBe("accepted");
  });

  it("is pending while unaccepted and unexpired", () => {
    expect(inviteStatus({ acceptedAt: null, expiresAt: "2026-07-21T00:00:00Z" }, now)).toBe(
      "pending"
    );
  });

  it("is expired once the deadline passes without acceptance", () => {
    expect(inviteStatus({ acceptedAt: null, expiresAt: "2026-07-07T11:59:59Z" }, now)).toBe(
      "expired"
    );
  });
});
