import { describe, expect, it } from "vitest";

import { foundingMemberEmail } from "@/lib/admin/founding-admin";
import type { OrgRosterMember } from "@/lib/members/manage";

function makeMember(overrides: Partial<OrgRosterMember> = {}): OrgRosterMember {
  return {
    userId: "u1",
    email: "member@x.com",
    role: "admin",
    createdAt: "2026-08-01T00:00:00Z",
    isExperientialAdmin: false,
    ...overrides
  };
}

describe("foundingMemberEmail", () => {
  it("picks the EARLIEST-joined admin, not a later one", () => {
    const email = foundingMemberEmail([
      makeMember({ userId: "u2", email: "later@x.com", createdAt: "2026-08-05T00:00:00Z" }),
      makeMember({ userId: "u1", email: "founder@x.com", createdAt: "2026-08-01T00:00:00Z" })
    ]);
    expect(email).toBe("founder@x.com");
  });

  it("prefers an admin over an earlier-joined non-admin member", () => {
    const email = foundingMemberEmail([
      makeMember({ userId: "u1", email: "employee@x.com", role: "user", createdAt: "2026-07-01T00:00:00Z" }),
      makeMember({ userId: "u2", email: "boss@x.com", role: "admin", createdAt: "2026-08-01T00:00:00Z" })
    ]);
    expect(email).toBe("boss@x.com");
  });

  it("falls back to the earliest member of any role when no admin has an email", () => {
    const email = foundingMemberEmail([
      makeMember({ userId: "u2", email: "second@x.com", role: "user", createdAt: "2026-08-02T00:00:00Z" }),
      makeMember({ userId: "u1", email: "first@x.com", role: "user", createdAt: "2026-08-01T00:00:00Z" })
    ]);
    expect(email).toBe("first@x.com");
  });

  it("skips a null-email admin in favor of the next emailed admin", () => {
    const email = foundingMemberEmail([
      makeMember({ userId: "u1", email: null, createdAt: "2026-08-01T00:00:00Z" }),
      makeMember({ userId: "u2", email: "second-admin@x.com", createdAt: "2026-08-02T00:00:00Z" })
    ]);
    expect(email).toBe("second-admin@x.com");
  });

  it("returns null for an empty or entirely email-less roster", () => {
    expect(foundingMemberEmail([])).toBeNull();
    expect(foundingMemberEmail([makeMember({ email: null })])).toBeNull();
  });
});
