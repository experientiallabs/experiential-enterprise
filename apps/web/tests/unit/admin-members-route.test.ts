import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const sendOrgInviteEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));
vi.mock("@/lib/admin/invite-email", () => ({ sendOrgInviteEmail }));

import { POST } from "@/app/api/admin/orgs/[orgId]/members/route";

const context = { params: Promise.resolve({ orgId: "org-1" }) };

function request(payload: unknown) {
  const value = new Request("https://platform.example/api/admin/orgs/org-1/members", {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  Object.defineProperty(value, "nextUrl", {
    value: new URL(value.url)
  });
  return value;
}

// Production binds 0.0.0.0:3000, so nextUrl.origin is the bind address. Invite
// URLs must follow requestOrigin (forwarded host/proto), not that bind origin.
function bindAddressRequest(payload: unknown): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/admin/orgs/org-1/members", {
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

function adminClient(
  userId: string | null,
  pendingInvite: { id: string; token: string; role: string } | null = null
) {
  const membershipInsert = vi.fn();
  const invitationInsert = vi.fn();
  const invitationUpdate = vi.fn();
  const client = {
    membershipInsert,
    invitationInsert,
    invitationUpdate,
    rpc: vi.fn().mockResolvedValue({ data: userId, error: null }),
    from: vi.fn((table: string) => {
      if (table === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { name: "Acme" }, error: null })
            })
          })
        };
      }
      if (table === "organization_members") {
        return {
          insert: (row: unknown) => {
            membershipInsert(row);
            return {
              select: () => ({
                single: async () => ({ data: row, error: null })
              })
            };
          }
        };
      }
      if (table === "org_invitations") {
        const cleanup = {
          eq: () => cleanup,
          is: () => cleanup,
          lte: async () => ({ error: null })
        };
        const pending = {
          eq: () => pending,
          is: () => pending,
          gt: () => pending,
          maybeSingle: async () => ({ data: pendingInvite, error: null })
        };
        return {
          delete: () => cleanup,
          select: () => pending,
          insert: (row: unknown) => {
            invitationInsert(row);
            return {
              select: () => ({
                single: async () => ({
                  data: { id: "invite-1", token: "invite-token", role: "admin" },
                  error: null
                })
              })
            };
          },
          update: (row: { role: string }) => {
            invitationUpdate(row);
            return {
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: pendingInvite
                      ? { ...pendingInvite, role: row.role }
                      : null,
                    error: null
                  })
                })
              })
            };
          }
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    })
  };
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  requireAuthenticatedUser.mockResolvedValue({ id: "operator-1" });
  sendOrgInviteEmail.mockResolvedValue({ sent: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/admin/orgs/[orgId]/members", () => {
  it("hides the endpoint from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await POST(
      request({ email: "member@example.com", role: "user" }) as never,
      context
    );

    expect(response.status).toBe(404);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("adds an existing account immediately", async () => {
    const client = adminClient("user-1");
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await POST(
      request({ email: "Member@Example.com", role: "admin" }) as never,
      context
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ action: "added" });
    expect(client.membershipInsert).toHaveBeenCalledWith({
      org_id: "org-1",
      user_id: "user-1",
      role: "admin"
    });
    expect(sendOrgInviteEmail).not.toHaveBeenCalled();
  });

  it("invites a new account into the selected organization", async () => {
    const client = adminClient(null);
    createServiceRoleSupabaseClient.mockReturnValue(client);
    sendOrgInviteEmail.mockResolvedValue({ sent: false, reason: "Resend is not configured" });

    const response = await POST(
      request({ email: "New@Example.com", role: "admin" }) as never,
      context
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      action: "invited",
      invitationId: "invite-1",
      role: "admin",
      email: { sent: false, reason: "Resend is not configured" },
      inviteUrl: "https://platform.example/signin?invite=invite-token"
    });
    expect(client.invitationInsert).toHaveBeenCalledWith({
      org_id: "org-1",
      email: "new@example.com",
      role: "admin",
      invited_by: "operator-1"
    });
    expect(sendOrgInviteEmail).toHaveBeenCalledWith({
      to: "new@example.com",
      orgName: "Acme",
      role: "admin",
      inviteUrl: "https://platform.example/signin?invite=invite-token"
    });
  });

  it("resends and recovers a live pending invite instead of returning a duplicate error", async () => {
    const client = adminClient(null, {
      id: "invite-existing",
      token: "existing-token",
      role: "user"
    });
    createServiceRoleSupabaseClient.mockReturnValue(client);
    sendOrgInviteEmail.mockResolvedValue({ sent: false, reason: "delivery unavailable" });

    const response = await POST(
      request({ email: "Pending@Example.com", role: "admin" }) as never,
      context
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      action: "invited",
      invitationId: "invite-existing",
      role: "admin",
      inviteUrl: "https://platform.example/signin?invite=existing-token"
    });
    expect(client.invitationInsert).not.toHaveBeenCalled();
    expect(client.invitationUpdate).toHaveBeenCalledWith({ role: "admin" });
    expect(sendOrgInviteEmail).toHaveBeenCalledWith({
      to: "pending@example.com",
      orgName: "Acme",
      role: "admin",
      inviteUrl: "https://platform.example/signin?invite=existing-token"
    });
  });

  it("keeps a matching pending invite role without rewriting the row", async () => {
    const client = adminClient(null, {
      id: "invite-existing",
      token: "existing-token",
      role: "admin"
    });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await POST(
      request({ email: "Pending@Example.com", role: "admin" }) as never,
      context
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      action: "invited",
      invitationId: "invite-existing",
      role: "admin"
    });
    expect(client.invitationUpdate).not.toHaveBeenCalled();
    expect(sendOrgInviteEmail).toHaveBeenCalledWith({
      to: "pending@example.com",
      orgName: "Acme",
      role: "admin",
      inviteUrl: "https://platform.example/signin?invite=existing-token"
    });
  });

  it("builds invite URLs from the public origin, not the 0.0.0.0 bind address", async () => {
    // Empty, not unset: a valid ambient EXPLABS_WEBAPP_URL would otherwise
    // win over the forwarded headers this case is pinning.
    vi.stubEnv("EXPLABS_WEBAPP_URL", "");
    const client = adminClient(null);
    createServiceRoleSupabaseClient.mockReturnValue(client);
    sendOrgInviteEmail.mockResolvedValue({ sent: false, reason: "Resend is not configured" });

    const response = await POST(
      bindAddressRequest({ email: "new@example.com", role: "admin" }),
      context
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.inviteUrl).toBe(
      "https://platform.experientiallabs.ai/signin?invite=invite-token"
    );
    expect(body.inviteUrl).not.toContain("0.0.0.0");
    expect(sendOrgInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteUrl: "https://platform.experientiallabs.ai/signin?invite=invite-token"
      })
    );
  });
});
