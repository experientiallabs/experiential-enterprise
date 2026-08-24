import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient, requireAuthenticatedUser }));
vi.mock("@/lib/auth/admin", () => ({
  createServiceRoleSupabaseClient,
  // These scenarios exercise the ordinary member path, mirroring the revoke
  // route's tests; the platform-admin bypass has no membership lookup.
  isPlatformAdmin: async () => false
}));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));

import { POST } from "@/app/api/keys/[keyId]/rotate/route";

const OLD_KEY = {
  id: "k-old",
  org_id: "org-1",
  name: "prod",
  identity_id: "org-org-1",
  revoked_at: null
};

const NEW_KEY_ROW = {
  id: "k-new",
  org_id: "org-1",
  name: "prod",
  key_prefix: "xpl_new",
  created_at: "2026-08-21T00:00:00Z",
  last_used_at: null,
  revoked_at: null,
  expires_at: null,
  identity_id: "org-org-1"
};

// The caller's RLS-scoped client resolving the old-key lookup.
function rlsClient(row: unknown) {
  const filterable = {
    eq: () => filterable,
    maybeSingle: async () => ({ data: row, error: null })
  };
  return { from: () => ({ select: () => filterable }) };
}

type RecordedUpdate = { payload: Record<string, unknown>; id: string };

// The service-role client: records the replacement insert, every update with
// its target id, and audit RPCs; `expireError` fails exactly the old-key
// expiry write so the compensation path can be exercised.
function rotateAdminClient(opts: { expireError?: boolean } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: RecordedUpdate[] = [];
  const rpc = vi.fn(async () => ({ error: null }));
  return {
    inserts,
    updates,
    rpc,
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return {
          select: () => ({ single: async () => ({ data: NEW_KEY_ROW, error: null }) })
        };
      },
      update: (payload: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          updates.push({ payload, id });
          if (opts.expireError && "expires_at" in payload) {
            return { error: { message: "db down" } };
          }
          return { error: null };
        }
      })
    })
  };
}

function rotateRequest(body?: unknown): Request {
  return new Request("http://localhost/api/keys/k-old/rotate", {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

const context = { params: Promise.resolve({ keyId: "k-old" }) };

function expiryHoursFromNow(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / (60 * 60 * 1000);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "u1" });
  createServerSupabaseClient.mockResolvedValue(rlsClient(OLD_KEY));
  isOrgAdmin.mockResolvedValue(true);
});

describe("POST /api/keys/[keyId]/rotate", () => {
  it("mints a same-shaped replacement, schedules the old key's expiry, and audits", async () => {
    const admin = rotateAdminClient();
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await POST(rotateRequest({}) as never, context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    // The replacement inherits org, identity, and name; the secret appears
    // exactly once, here.
    expect(admin.inserts[0]).toMatchObject({
      org_id: "org-1",
      name: "prod",
      identity_id: "org-org-1",
      created_by: "u1",
      expires_at: null
    });
    expect(payload.apiKey).toEqual(NEW_KEY_ROW);
    expect(payload.secret).toMatch(/^xpl_/);
    // The old key is NOT revoked — it expires after the default 24h overlap.
    expect(admin.updates).toHaveLength(1);
    expect(admin.updates[0].id).toBe("k-old");
    expect(admin.updates[0].payload).not.toHaveProperty("revoked_at");
    expect(expiryHoursFromNow(payload.oldKeyExpiresAt)).toBeCloseTo(24, 1);
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_audit_event",
      expect.objectContaining({
        p_action: "keys.rotate",
        p_object_id: "k-old",
        p_after: { replacementKeyId: "k-new", oldKeyExpiresAt: payload.oldKeyExpiresAt }
      })
    );
  });

  it("clamps the overlap window into [1, 72] hours", async () => {
    const admin = rotateAdminClient();
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const tooLong = await POST(rotateRequest({ overlapHours: 100 }) as never, context);
    expect(expiryHoursFromNow((await tooLong.json()).oldKeyExpiresAt)).toBeCloseTo(72, 1);

    const tooShort = await POST(rotateRequest({ overlapHours: 0.25 }) as never, context);
    expect(expiryHoursFromNow((await tooShort.json()).oldKeyExpiresAt)).toBeCloseTo(1, 1);
  });

  it("400s a non-numeric overlap before touching any key", async () => {
    const admin = rotateAdminClient();
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await POST(rotateRequest({ overlapHours: "tomorrow" }) as never, context);

    expect(response.status).toBe(400);
    expect(admin.inserts).toHaveLength(0);
  });

  it("revokes the freshly minted key and 500s when the expiry write fails", async () => {
    const admin = rotateAdminClient({ expireError: true });
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await POST(rotateRequest({}) as never, context);

    expect(response.status).toBe(500);
    // Compensation: the replacement never stays live without the rotation.
    const compensation = admin.updates.find((update) => update.id === "k-new");
    expect(compensation?.payload.revoked_at).toEqual(expect.any(String));
    expect(compensation?.payload.revoked_by).toBe("u1");
    // No rotation happened, so none is recorded.
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("409s an already-revoked key", async () => {
    createServerSupabaseClient.mockResolvedValue(
      rlsClient({ ...OLD_KEY, revoked_at: "2026-08-01T00:00:00Z" })
    );

    const response = await POST(rotateRequest({}) as never, context);

    expect(response.status).toBe(409);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("404s when the RLS-scoped client cannot see the key, hiding foreign orgs", async () => {
    createServerSupabaseClient.mockResolvedValue(rlsClient(null));

    const response = await POST(rotateRequest({}) as never, context);

    expect(response.status).toBe(404);
    expect(isOrgAdmin).not.toHaveBeenCalled();
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("403s an own-org member who is not an admin", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await POST(rotateRequest({}) as never, context);

    expect(response.status).toBe(403);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });
});
