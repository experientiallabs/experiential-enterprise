import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient, requireAuthenticatedUser }));
vi.mock("@/lib/auth/admin", () => ({
  createServiceRoleSupabaseClient,
  // These scenarios exercise the ordinary member path; the platform-admin
  // bypass has no membership lookup to hide behind.
  isPlatformAdmin: async () => false
}));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));

import { GET, POST } from "@/app/api/keys/route";
import { DELETE } from "@/app/api/keys/[keyId]/route";

// The caller's RLS-scoped client, resolving a lookup to one row or nothing.
// `eq` chains onto itself so both the one-filter key lookup and the
// (org, user) membership lookup resolve through the same stub.
function rlsClient(row: unknown) {
  const filterable = {
    eq: () => filterable,
    maybeSingle: async () => ({ data: row, error: null })
  };
  return {
    from: () => ({
      select: () => filterable
    })
  };
}

function adminClient(insertedRow: unknown, { orgBannedAt = null }: { orgBannedAt?: string | null } = {}) {
  const rpc = vi.fn(async (..._args: unknown[]) => ({ error: null }));
  return {
    rpc,
    from: (table: string) => {
      if (table === "organizations") {
        // The mint route refuses banned orgs before touching identities/keys.
        const filterable = {
          eq: () => filterable,
          maybeSingle: async () => ({ data: { banned_at: orgBannedAt }, error: null })
        };
        return { select: () => filterable };
      }
      if (table === "gateway_identities") {
        // The mint route ensures the org's default identity exists (idempotent
        // upsert) when no explicit identity is requested.
        return { upsert: async () => ({ error: null }) };
      }
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: insertedRow, error: null }) })
        }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
  };
}

function mintRequest(): Request {
  return new Request("http://localhost/api/keys", {
    body: JSON.stringify({ orgId: "org-1", name: "prod" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

beforeEach(() => {
  requireAuthenticatedUser.mockReset().mockResolvedValue({ id: "u1" });
  createServerSupabaseClient.mockReset();
  createServiceRoleSupabaseClient.mockReset();
  isOrgAdmin.mockReset();
});

describe("POST /api/keys", () => {
  it("404s when the RLS-scoped client cannot see the org, hiding foreign orgs", async () => {
    createServerSupabaseClient.mockResolvedValue(rlsClient(null));

    const response = await POST(mintRequest() as never);

    expect(response.status).toBe(404);
    // The admin check and service role never run for an invisible org.
    expect(isOrgAdmin).not.toHaveBeenCalled();
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("403s an own-org member who is not an admin", async () => {
    createServerSupabaseClient.mockResolvedValue(rlsClient({ org_id: "org-1" }));
    isOrgAdmin.mockResolvedValue(false);

    const response = await POST(mintRequest() as never);

    expect(response.status).toBe(403);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("mints through the service role for an org admin and audits the mint", async () => {
    const row = { id: "k1", org_id: "org-1", name: "prod" };
    createServerSupabaseClient.mockResolvedValue(rlsClient({ org_id: "org-1" }));
    isOrgAdmin.mockResolvedValue(true);
    const admin = adminClient(row);
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await POST(mintRequest() as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.apiKey).toEqual(row);
    expect(payload.secret).toMatch(/^xpl_/);
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_audit_event",
      expect.objectContaining({ p_action: "keys.mint", p_actor_kind: "user", p_object_id: "k1" })
    );
    // The audit snapshot never carries the secret or its hash.
    const auditArgs = JSON.stringify(admin.rpc.mock.calls[0][1]);
    expect(auditArgs).not.toContain(payload.secret);
    expect(auditArgs).not.toContain("key_hash");
  });

  it("403s a banned org: the ban revoked its keys and no new ones may exist", async () => {
    createServerSupabaseClient.mockResolvedValue(rlsClient({ org_id: "org-1" }));
    isOrgAdmin.mockResolvedValue(true);
    createServiceRoleSupabaseClient.mockReturnValue(
      adminClient(null, { orgBannedAt: "2026-08-29T00:00:00Z" })
    );

    const response = await POST(mintRequest() as never);
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toMatch(/banned/);
  });
});

// A member's RLS client serving both the membership gate and the shared
// listOrgApiKeys read: the count query answers through the thenable builder,
// the rows query through `range`. Select columns and revoked filters are
// recorded so tests can pin exactly which fields leave the database.
function memberKeysClient(opts: { membership: unknown; total: number; rows: unknown[] }) {
  const keySelects: string[] = [];
  const revokedFilters: string[] = [];
  const client = {
    keySelects,
    revokedFilters,
    from(table: string) {
      if (table === "organization_members") {
        const filterable = {
          eq: () => filterable,
          maybeSingle: async () => ({ data: opts.membership, error: null })
        };
        return { select: () => filterable };
      }
      return {
        select(columns: string, options?: { head?: boolean }) {
          keySelects.push(columns);
          const result =
            options?.head === true
              ? { count: opts.total, error: null }
              : { data: opts.rows, error: null };
          const builder = {
            eq: () => builder,
            is(column: string) {
              revokedFilters.push(column);
              return builder;
            },
            order: () => builder,
            range: async () => ({ data: opts.rows, error: null }),
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
              Promise.resolve(result).then(resolve, reject)
          };
          return builder;
        }
      };
    }
  };
  return client;
}

function listRequest(query: string): Request {
  return new Request(`http://localhost/api/keys?${query}`, { method: "GET" });
}

describe("GET /api/keys", () => {
  it("404s a non-member, hiding foreign orgs exactly like the mint route", async () => {
    createServerSupabaseClient.mockResolvedValue(
      memberKeysClient({ membership: null, total: 0, rows: [] })
    );

    const response = await GET(listRequest("orgId=org-1") as never);

    expect(response.status).toBe(404);
    // Listing is member-level: the admin check never gates a read, and the
    // service role never runs for an invisible org.
    expect(isOrgAdmin).not.toHaveBeenCalled();
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("requires orgId", async () => {
    const response = await GET(listRequest("page=1") as never);
    expect(response.status).toBe(400);
  });

  it("lists a member's keys with clamped paging and never a hash or secret", async () => {
    const row = {
      id: "k1",
      org_id: "org-1",
      name: "prod",
      key_prefix: "xpl_ab12",
      key_suffix: "f2e1",
      created_at: "2026-08-01T00:00:00Z",
      last_used_at: null,
      revoked_at: null,
      expires_at: null
    };
    const client = memberKeysClient({ membership: { org_id: "org-1" }, total: 25, rows: [row] });
    createServerSupabaseClient.mockResolvedValue(client);

    const response = await GET(listRequest("orgId=org-1&page=9") as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    // 25 keys at 10 per page: the out-of-range ?page=9 clamps to the last page.
    expect(payload).toEqual({ keys: [row], page: 3, pageCount: 3, total: 25 });
    // The revoked filter applies to the count and the rows alike by default.
    expect(client.revokedFilters).toEqual(["revoked_at", "revoked_at"]);
    // The no-secrets contract: neither the selected columns nor the response
    // body ever carry the stored hash or a plaintext secret.
    for (const columns of client.keySelects) {
      expect(columns).not.toContain("key_hash");
    }
    expect(JSON.stringify(payload)).not.toContain("key_hash");
  });

  it("includes revoked keys only when asked", async () => {
    const client = memberKeysClient({ membership: { org_id: "org-1" }, total: 1, rows: [] });
    createServerSupabaseClient.mockResolvedValue(client);

    const response = await GET(listRequest("orgId=org-1&revoked=1") as never);

    expect(response.status).toBe(200);
    expect(client.revokedFilters).toEqual([]);
  });
});

describe("DELETE /api/keys/[keyId]", () => {
  it("404s when the RLS-scoped client cannot see the key, hiding foreign orgs", async () => {
    createServerSupabaseClient.mockResolvedValue(rlsClient(null));

    const response = await DELETE(new Request("http://localhost/api/keys/k9") as never, {
      params: Promise.resolve({ keyId: "k9" })
    });

    expect(response.status).toBe(404);
    expect(isOrgAdmin).not.toHaveBeenCalled();
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("revokes an own-org key through the service role for an admin and audits it", async () => {
    createServerSupabaseClient.mockResolvedValue(
      rlsClient({ id: "k1", org_id: "org-1", revoked_at: null })
    );
    isOrgAdmin.mockResolvedValue(true);
    const admin = adminClient(null);
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await DELETE(new Request("http://localhost/api/keys/k1") as never, {
      params: Promise.resolve({ keyId: "k1" })
    });

    expect(response.status).toBe(204);
    expect(admin.rpc).toHaveBeenCalledWith(
      "record_audit_event",
      expect.objectContaining({ p_action: "keys.revoke", p_object_id: "k1" })
    );
  });
});
