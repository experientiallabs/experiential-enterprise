import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isSignupAllowed } from "@/lib/auth/signup-gate";

type TableFixtures = {
  signupsEnabled: boolean;
  pendingInviteCount: number;
  tokenInviteCount?: number;
};

// Minimal chainable stand-in for the two PostgREST queries the gate runs.
function fakeServiceClient(fixtures: TableFixtures): SupabaseClient {
  return {
    from(table: string) {
      if (table === "app_settings") {
        return {
          select: () => ({
            maybeSingle: async () => ({
              data: { signups_enabled: fixtures.signupsEnabled },
              error: null
            })
          })
        };
      }
      if (table === "org_invitations") {
        // The first eq() names the matched column, so token and email lookups
        // can resolve to different fixture counts.
        function makeChain(column: string | null) {
          const chain = {
            eq: (col: string) => makeChain(column ?? col),
            is: () => chain,
            gt: () =>
              Promise.resolve({
                count:
                  column === "token"
                    ? (fixtures.tokenInviteCount ?? 0)
                    : fixtures.pendingInviteCount,
                error: null
              })
          };
          return chain;
        }
        return { select: () => makeChain(null) };
      }
      throw new Error(`Unexpected table: ${table}`);
    }
  } as unknown as SupabaseClient;
}

describe("isSignupAllowed", () => {
  it("allows any signup when the platform flag is on", async () => {
    const client = fakeServiceClient({ signupsEnabled: true, pendingInviteCount: 0 });
    await expect(isSignupAllowed(client, "anyone@example.com")).resolves.toBe(true);
  });

  it("rejects an invited email with no token while signups are disabled", async () => {
    // An unverified signup email is not proof of inbox ownership, so it must
    // not pass the gate even when a pending invite exists for that address.
    const client = fakeServiceClient({ signupsEnabled: false, pendingInviteCount: 1 });
    await expect(isSignupAllowed(client, "Invited@Example.com")).resolves.toBe(false);
  });

  it("rejects uninvited emails while signups are disabled", async () => {
    const client = fakeServiceClient({ signupsEnabled: false, pendingInviteCount: 0 });
    await expect(isSignupAllowed(client, "stranger@example.com")).resolves.toBe(false);
  });

  it("allows a live invite-link token even for an unmatched email", async () => {
    const client = fakeServiceClient({
      signupsEnabled: false,
      pendingInviteCount: 0,
      tokenInviteCount: 1
    });
    await expect(isSignupAllowed(client, "other@example.com", "tok123")).resolves.toBe(true);
  });

  it("rejects an unknown token when the email holds no invite", async () => {
    const client = fakeServiceClient({
      signupsEnabled: false,
      pendingInviteCount: 0,
      tokenInviteCount: 0
    });
    await expect(isSignupAllowed(client, "other@example.com", "bogus")).resolves.toBe(false);
  });
});
