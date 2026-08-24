import { describe, expect, it } from "vitest";

import {
  invitationLink,
  invitationStatus,
  type OrgInvitation
} from "@/lib/admin/invitations";

function makeInvitation(overrides: Partial<OrgInvitation> = {}): OrgInvitation {
  return {
    id: "inv-1",
    email: "invitee@example.com",
    token: "tok-123",
    org_id: null,
    role: "user",
    org_name: "Acme Traces",
    created_at: "2026-07-01T00:00:00Z",
    expires_at: "2026-07-15T00:00:00Z",
    accepted_at: null,
    revoked_at: null,
    ...overrides
  };
}

describe("invitationStatus", () => {
  const now = new Date("2026-07-07T00:00:00Z");

  it("reports a live unexpired invite as pending", () => {
    expect(invitationStatus(makeInvitation(), now)).toBe("pending");
  });

  it("prefers accepted over revoked and expiry", () => {
    const invitation = makeInvitation({
      accepted_at: "2026-07-02T00:00:00Z",
      revoked_at: "2026-07-03T00:00:00Z",
      expires_at: "2026-07-01T00:00:00Z"
    });
    expect(invitationStatus(invitation, now)).toBe("accepted");
  });

  it("reports revoked before expiry", () => {
    const invitation = makeInvitation({
      revoked_at: "2026-07-03T00:00:00Z",
      expires_at: "2026-07-01T00:00:00Z"
    });
    expect(invitationStatus(invitation, now)).toBe("revoked");
  });

  it("reports past expiry as expired", () => {
    expect(invitationStatus(makeInvitation({ expires_at: "2026-07-06T00:00:00Z" }), now)).toBe(
      "expired"
    );
  });
});

describe("invitationLink", () => {
  it("builds the signup link from the origin and token", () => {
    expect(invitationLink("https://app.example.com/", makeInvitation().token)).toBe(
      "https://app.example.com/signin?invite=tok-123"
    );
  });
});
