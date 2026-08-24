import { afterEach, describe, expect, it, vi } from "vitest";

// A fixed minted secret so the test asserts the exact insert payload.
const mintApiKeySecret = vi.hoisted(() =>
  vi.fn(() => ({
    secret: "xpl_deadbeef",
    keyPrefix: "xpl_deadbee",
    keySuffix: "beef",
    keyHash: "hash-of-xpl_deadbeef"
  }))
);
vi.mock("@/lib/api-keys/keys", () => ({ mintApiKeySecret }));

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));

import { mintPlaygroundServingKey } from "@/lib/playground/serving-key";

/** A service-role client stub that records the insert/upsert payloads and revoke calls. */
function adminClient(options: {
  insertedId: string | null;
  insertError?: string;
  orgBannedAt?: string | null;
}) {
  const insert = vi.fn();
  const upsert = vi.fn(async (_payload: unknown, _config: unknown) => ({ error: null }));
  const update = vi.fn();
  const eq = vi.fn(async () => ({ error: null }));
  const client = {
    from(table: string) {
      if (table === "organizations") {
        // The mint refuses banned orgs before touching identities or keys.
        const filterable = {
          eq: () => filterable,
          maybeSingle: async () => ({
            data: { banned_at: options.orgBannedAt ?? null },
            error: null
          })
        };
        return { select: () => filterable };
      }
      return {
        upsert: (payload: unknown, config: unknown) => upsert(payload, config),
        insert: (payload: unknown) => {
          insert(payload);
          return {
            select: () => ({
              single: async () => ({
                data: options.insertedId === null ? null : { id: options.insertedId },
                error: options.insertError ? { message: options.insertError } : null
              })
            })
          };
        },
        update: (payload: unknown) => {
          update(payload);
          return { eq };
        }
      };
    }
  };
  return { client, insert, upsert, update, eq };
}

// Postgres' error text for the api_keys -> gateway_identities FK, so the fake
// below fails exactly the way the real database does when the identity is absent.
const FK_VIOLATION =
  'insert or update on table "api_keys" violates foreign key constraint "api_keys_identity_id_fkey"';

/**
 * A service-role client fake that MODELS the api_keys.identity_id foreign key.
 *
 * The mocked-client tests above cannot catch the launch bug (#492) because they
 * accept any insert. This fake keeps an in-memory gateway_identities set and
 * rejects an api_keys insert whose identity_id is absent from it, exactly like
 * the FK constraint. On the pre-fix code (no get-or-create) an org with no
 * seeded identity trips the constraint and the mint throws; the get-or-create
 * upserts the identity first, so the insert succeeds.
 */
function fkModelingClient(options: { existingIdentities?: readonly string[] } = {}) {
  const identities = new Set<string>(options.existingIdentities ?? []);
  const apiKeys: Array<Record<string, unknown>> = [];
  let nextId = 1;
  const client = {
    from(table: string) {
      if (table === "organizations") {
        const filterable = {
          eq: () => filterable,
          maybeSingle: async () => ({ data: { banned_at: null }, error: null })
        };
        return { select: () => filterable };
      }
      if (table === "gateway_identities") {
        return {
          upsert: async (payload: { identity_id: string }) => {
            identities.add(payload.identity_id);
            return { error: null };
          }
        };
      }
      return {
        insert: (payload: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              const identityId = payload.identity_id;
              if (typeof identityId === "string" && !identities.has(identityId)) {
                return { data: null, error: { message: FK_VIOLATION } };
              }
              const id = `key-${nextId++}`;
              apiKeys.push({ id, ...payload });
              return { data: { id }, error: null };
            }
          })
        }),
        update: () => ({ eq: async () => ({ error: null }) })
      };
    }
  };
  return { client, identities, apiKeys };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("mintPlaygroundServingKey", () => {
  it("mints an org-scoped key carrying the org's default identity", async () => {
    const { client, insert, upsert } = adminClient({ insertedId: "key-1" });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const key = await mintPlaygroundServingKey("org-uuid-1", "user-1");

    expect(key.secret).toBe("xpl_deadbeef");
    // The default identity is get-or-created before the key insert so the FK
    // holds; the id and display name match the structural seed exactly.
    expect(upsert).toHaveBeenCalledWith(
      { identity_id: "org-org-uuid-1", org_id: "org-uuid-1", display_name: "Default" },
      { onConflict: "identity_id", ignoreDuplicates: true }
    );
    expect(insert).toHaveBeenCalledWith({
      org_id: "org-uuid-1",
      name: "Playground session",
      key_prefix: "xpl_deadbee",
      key_suffix: "beef",
      key_hash: "hash-of-xpl_deadbeef",
      created_by: "user-1",
      // Matches the control store's organization_artifact_id so the org's
      // deny-by-default grants apply to this key.
      identity_id: "org-org-uuid-1"
    });
  });

  it("mints for an org with no seeded default identity (models the api_keys FK)", async () => {
    // The launch bug: this org has NO gateway_identities row. On the pre-fix
    // code the api_keys insert trips api_keys_identity_id_fkey and the route
    // 500s; the get-or-create must create the identity first so the mint works.
    const { client, identities, apiKeys } = fkModelingClient({ existingIdentities: [] });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const key = await mintPlaygroundServingKey("org-uuid-1", "user-1");

    expect(key.secret).toBe("xpl_deadbeef");
    expect(identities.has("org-org-uuid-1")).toBe(true);
    expect(apiKeys).toHaveLength(1);
    expect(apiKeys[0].identity_id).toBe("org-org-uuid-1");
  });

  it("mints for an org whose default identity already exists (composes with the seed)", async () => {
    const { client, identities, apiKeys } = fkModelingClient({
      existingIdentities: ["org-org-uuid-1"]
    });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const key = await mintPlaygroundServingKey("org-uuid-1", "user-1");

    expect(key.secret).toBe("xpl_deadbeef");
    // No duplicate identity, and the key still mints against the seeded row.
    expect([...identities]).toEqual(["org-org-uuid-1"]);
    expect(apiKeys).toHaveLength(1);
  });

  it("revokes the key once, idempotently", async () => {
    const { client, update, eq } = adminClient({ insertedId: "key-1" });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const key = await mintPlaygroundServingKey("org-uuid-1", "user-1");
    await key.revoke();
    await key.revoke();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toHaveProperty("revoked_at");
    expect(eq).toHaveBeenCalledWith("id", "key-1");
  });

  it("fails loudly when the key row cannot be provisioned", async () => {
    const { client } = adminClient({ insertedId: null, insertError: "insert denied" });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    await expect(mintPlaygroundServingKey("org-uuid-1", "user-1")).rejects.toThrow(
      /insert denied/
    );
  });

  it("refuses a banned org without minting anything", async () => {
    const { client, insert, upsert } = adminClient({
      insertedId: "key-1",
      orgBannedAt: "2026-08-29T00:00:00Z"
    });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    await expect(mintPlaygroundServingKey("org-uuid-1", "user-1")).rejects.toThrow(/banned/);
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
