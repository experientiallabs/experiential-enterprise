import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const mintSuperadminKey = vi.hoisted(() => vi.fn());
const revokeSuperadminKeysForUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));
vi.mock("@/lib/admin/superadmin-keys", () => ({
  mintSuperadminKey,
  revokeSuperadminKeysForUser
}));

import { DELETE, PUT } from "@/app/api/admin/users/[userId]/site-admin/route";

const context = { params: Promise.resolve({ userId: "user-1" }) };

const SECRET = "xpladmin_" + "a".repeat(40);

function request(method: string) {
  return new Request("https://platform.example/api/admin/users/user-1/site-admin", { method });
}

function adminClient({
  userExists = true,
  userEmail = "target@x.com" as string | null,
  banned = false,
  insertedRows = [{ user_id: "user-1" }],
  hasGrant = true,
  deleteError = null as { message: string } | null
}: {
  userExists?: boolean;
  userEmail?: string | null;
  banned?: boolean;
  insertedRows?: Array<{ user_id: string }>;
  hasGrant?: boolean;
  deleteError?: { message: string } | null;
} = {}) {
  // ignoreDuplicates upserts return the row only when it was actually
  // inserted; a re-grant selects nothing.
  const upsertSelect = vi.fn().mockResolvedValue({ data: insertedRows, error: null });
  const upsert = vi.fn(() => ({ select: upsertSelect }));
  const grantLookup = vi
    .fn()
    .mockResolvedValue({ data: hasGrant ? { user_id: "user-1" } : null, error: null });
  const deleteEq = vi.fn().mockResolvedValue({ error: deleteError });
  const deleteGrant = vi.fn(() => ({ eq: deleteEq }));
  const banLookup = vi
    .fn()
    .mockResolvedValue({ data: banned ? { user_id: "user-1" } : null, error: null });
  const client = {
    upsert,
    upsertSelect,
    deleteGrant,
    deleteEq,
    banLookup,
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue(
          userExists
            ? { data: { user: { id: "user-1", email: userEmail } }, error: null }
            : { data: { user: null }, error: { message: "missing" } }
        )
      }
    },
    from: vi.fn((table: string) => {
      if (table === "platform_admins") {
        return {
          upsert,
          select: () => ({ eq: () => ({ maybeSingle: grantLookup }) }),
          delete: deleteGrant
        };
      }
      if (table === "user_bans") {
        return { select: () => ({ eq: () => ({ maybeSingle: banLookup }) }) };
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
  mintSuperadminKey.mockResolvedValue({
    row: { name: "granted 2026-08-23" },
    secret: SECRET
  });
  revokeSuperadminKeysForUser.mockResolvedValue(1);
});

describe("PUT /api/admin/users/[userId]/site-admin", () => {
  it("hides the endpoint from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await PUT(request("PUT") as never, context);

    expect(response.status).toBe(404);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("grants with granter provenance and mints one superadmin key, revealing the secret once", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(request("PUT") as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "user-1",
      siteAdmin: true,
      key: { name: "granted 2026-08-23", secret: SECRET }
    });
    // The secret must never sit in a shared cache.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(client.upsert).toHaveBeenCalledWith(
      { user_id: "user-1", granted_by: "operator-1" },
      { onConflict: "user_id", ignoreDuplicates: true }
    );
    // The key belongs to the NEW admin, named for the grant date.
    expect(mintSuperadminKey).toHaveBeenCalledTimes(1);
    expect(mintSuperadminKey).toHaveBeenCalledWith(
      expect.stringMatching(/^granted \d{4}-\d{2}-\d{2}$/),
      "user-1",
      "target@x.com"
    );
  });

  it("refuses to grant to a BANNED account: it would mint a working machine credential", async () => {
    const client = adminClient({ banned: true });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(request("PUT") as never, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This account is banned. Unban it before granting experiential-admin status."
    });
    expect(client.upsert).not.toHaveBeenCalled();
    expect(mintSuperadminKey).not.toHaveBeenCalled();
  });

  it("re-granting an existing admin succeeds without minting a duplicate key", async () => {
    const client = adminClient({ insertedRows: [] });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(request("PUT") as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userId: "user-1", siteAdmin: true });
    expect(mintSuperadminKey).not.toHaveBeenCalled();
  });

  it("keeps the grant but reports a mint failure honestly, uncached", async () => {
    mintSuperadminKey.mockRejectedValue(new Error("insert refused"));
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(request("PUT") as never, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await response.json()) as { siteAdmin: boolean; mintError?: string };
    expect(payload.siteAdmin).toBe(true);
    expect(payload.mintError).toContain("insert refused");
  });

  it("grants an email-less account without minting an unattributable key", async () => {
    const client = adminClient({ userEmail: null });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(request("PUT") as never, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const payload = (await response.json()) as { siteAdmin: boolean; mintError?: string };
    expect(payload.siteAdmin).toBe(true);
    expect(payload.mintError).toContain("no email");
    expect(mintSuperadminKey).not.toHaveBeenCalled();
  });

  it("rejects unknown accounts", async () => {
    const client = adminClient({ userExists: false });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(request("PUT") as never, context);

    expect(response.status).toBe(404);
    expect(client.upsert).not.toHaveBeenCalled();
    expect(mintSuperadminKey).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/users/[userId]/site-admin", () => {
  it("revokes the grant AND every superadmin key, so a re-grant cannot revive old keys", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(request("DELETE") as never, context);

    expect(response.status).toBe(204);
    expect(revokeSuperadminKeysForUser).toHaveBeenCalledWith("user-1");
    expect(client.deleteEq).toHaveBeenCalledWith("user_id", "user-1");
    // Keys die BEFORE the membership row: a partial failure leaves a live
    // admin with dead keys, which a retry completes.
    expect(revokeSuperadminKeysForUser.mock.invocationCallOrder[0]).toBeLessThan(
      client.deleteEq.mock.invocationCallOrder[0]
    );
  });

  it("keeps the admin row when key revocation fails, so a retry can finish the job", async () => {
    revokeSuperadminKeysForUser.mockRejectedValue(new Error("db down"));
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(request("DELETE") as never, context);

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("still an admin");
    expect(client.deleteGrant).not.toHaveBeenCalled();
  });

  it("refuses self-revocation", async () => {
    requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(request("DELETE") as never, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "You cannot revoke your own site-admin access."
    });
    expect(revokeSuperadminKeysForUser).not.toHaveBeenCalled();
    expect(client.deleteGrant).not.toHaveBeenCalled();
  });

  it("404s when the account holds no grant, touching no keys", async () => {
    const client = adminClient({ hasGrant: false });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(request("DELETE") as never, context);

    expect(response.status).toBe(404);
    expect(revokeSuperadminKeysForUser).not.toHaveBeenCalled();
  });
});
