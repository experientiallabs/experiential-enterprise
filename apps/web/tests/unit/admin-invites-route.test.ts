import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const sendOrgInviteEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));
vi.mock("@/lib/admin/invite-email", () => ({ sendOrgInviteEmail }));

import { POST } from "@/app/api/admin/invites/route";

const ORG_ID = "00000000-0000-0000-0000-000000000001";

// Production binds 0.0.0.0:3000, so nextUrl.origin is the bind address. Invite
// emails must follow requestOrigin (forwarded host/proto), not that bind origin.
function bindAddressRequest(payload: unknown): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/admin/invites", {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      host: "0.0.0.0:3000",
      "x-forwarded-host": "platform.experientiallabs.ai",
      "x-forwarded-proto": "https"
    },
    method: "POST"
  });
}

function adminClient() {
  const invitationInsert = vi.fn();
  return {
    invitationInsert,
    rpc: vi.fn().mockResolvedValue({ data: "none", error: null }),
    from: vi.fn((table: string) => {
      if (table === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { name: "Acme", banned_at: null }, error: null })
            })
          })
        };
      }
      if (table === "org_invitations") {
        const cleanup = {
          eq: () => cleanup,
          is: () => cleanup,
          lte: async () => ({ error: null })
        };
        return {
          delete: () => cleanup,
          insert: (row: unknown) => {
            invitationInsert(row);
            return {
              select: () => ({
                single: async () => ({
                  data: { id: "invite-1", token: "invite-token" },
                  error: null
                })
              })
            };
          }
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    })
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  isOrgAdmin.mockResolvedValue(false);
  requireAuthenticatedUser.mockResolvedValue({ id: "operator-1" });
  sendOrgInviteEmail.mockResolvedValue({ sent: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/admin/invites", () => {
  it("emails invite URLs from the public origin, not the 0.0.0.0 bind address", async () => {
    // Empty, not unset: a valid ambient EXPLABS_WEBAPP_URL would otherwise
    // win over the forwarded headers this case is pinning.
    vi.stubEnv("EXPLABS_WEBAPP_URL", "");
    createServiceRoleSupabaseClient.mockReturnValue(adminClient());

    const response = await POST(
      bindAddressRequest({ email: "new@example.com", orgId: ORG_ID, role: "user" })
    );

    expect(response.status).toBe(200);
    expect(sendOrgInviteEmail).toHaveBeenCalledWith({
      to: "new@example.com",
      orgName: "Acme",
      role: "user",
      inviteUrl: "https://platform.experientiallabs.ai/signin?invite=invite-token"
    });
    const inviteUrl = (sendOrgInviteEmail.mock.calls[0][0] as { inviteUrl: string }).inviteUrl;
    expect(inviteUrl).not.toContain("0.0.0.0");
  });
});
