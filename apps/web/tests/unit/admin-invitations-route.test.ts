import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const createRouteSupabaseClient = vi.hoisted(() => vi.fn());
const sendInvitationEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/server")>("@/lib/auth/server");
  return { ...actual, createRouteSupabaseClient };
});
vi.mock("@/lib/admin/invite-email", () => ({ sendInvitationEmail }));

import { POST } from "@/app/api/admin/invitations/route";

const INVITATION = {
  id: "inv-1",
  email: "invitee@example.com",
  token: "tok-123",
  org_id: null,
  role: "user",
  org_name: "Acme Traces",
  created_at: "2026-07-01T00:00:00Z",
  expires_at: "2026-07-15T00:00:00Z",
  accepted_at: null,
  revoked_at: null
};

// Production binds 0.0.0.0:3000, so nextUrl.origin is the bind address. Invite
// emails must follow requestOrigin (forwarded host/proto), not that bind origin.
function bindAddressRequest(payload: unknown): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/admin/invitations", {
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

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  sendInvitationEmail.mockResolvedValue({ sent: true });
  createRouteSupabaseClient.mockReturnValue({
    rpc: vi.fn().mockResolvedValue({ data: "none", error: null }),
    from: vi.fn(() => ({
      insert: () => ({
        select: () => ({
          single: async () => ({ data: INVITATION, error: null })
        })
      })
    }))
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/admin/invitations", () => {
  it("emails invite URLs from the public origin, not the 0.0.0.0 bind address", async () => {
    // Empty, not unset: a valid ambient EXPLABS_WEBAPP_URL would otherwise
    // win over the forwarded headers this case is pinning.
    vi.stubEnv("EXPLABS_WEBAPP_URL", "");
    const response = await POST(
      bindAddressRequest({ email: "invitee@example.com", orgName: "Acme Traces" })
    );

    expect(response.status).toBe(201);
    expect(sendInvitationEmail).toHaveBeenCalledWith({
      to: "invitee@example.com",
      orgName: "Acme Traces",
      inviteUrl: "https://platform.experientiallabs.ai/signin?invite=tok-123"
    });
    const inviteUrl = (sendInvitationEmail.mock.calls[0][0] as { inviteUrl: string }).inviteUrl;
    expect(inviteUrl).not.toContain("0.0.0.0");
  });
});
