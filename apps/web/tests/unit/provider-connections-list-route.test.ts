import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceNotFoundError } from "@/lib/errors";
import { MODEL_PROVIDERS } from "@/lib/model-providers";

const requireOrgId = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/auth/server", () => ({
  AuthRequiredError: class extends Error {},
  createServerSupabaseClient
}));

import { GET } from "@/app/api/orgs/[orgId]/provider-connections/route";

function context(orgId = "org-1") {
  return { params: Promise.resolve({ orgId }) };
}

const request = new Request("http://localhost/api/orgs/org-1/provider-connections");

// A connected row exactly as the member-readable select returns it — the
// vault_secret_id column exists on the table but is never selected.
const ANTHROPIC_ROW = {
  provider: "anthropic",
  config: {},
  credential_last4: "ab12",
  spend_credential_last4: "cd34",
  updated_at: "2026-08-19T10:00:00Z",
  status: "invalid",
  status_detail: { raw_code: "authentication_error", remediation: "Rotate the key." },
  status_checked_at: "2026-08-19T10:00:01Z",
  status_source: "hookup_check",
  declared_balance_usd: 40,
  declared_balance_set_at: "2026-08-18T00:00:00Z",
  metered_spend_usd: 1.5,
  low_balance_threshold_usd: 5
};

const SNAPSHOT = {
  taken_at: "2026-08-19T09:00:00Z",
  spend_usd: 12.5,
  credits_remaining_usd: 58,
  usage_limit_usd: 100,
  source: "provider_api"
};

// A snapshot series as the history read returns it: newest-first from the DB
// (the loader reverses it to oldest→newest for the sparkline).
const HISTORY_NEWEST_FIRST = [
  { taken_at: "2026-08-19T09:00:00Z", spend_usd: 12.5, credits_remaining_usd: 58, source: "provider_api" },
  { taken_at: "2026-08-18T09:00:00Z", spend_usd: 8.0, credits_remaining_usd: 62, source: "provider_api" }
];

/**
 * The member's RLS client behind listProviderConnections. Reads are keyed by
 * table: provider_connections resolves through the thenable builder to the row
 * set; provider_account_snapshots answers maybeSingle with the latest snapshot
 * and the thenable (the history read) with the series. Select columns and
 * per-table call counts are recorded so tests can pin what leaves the database.
 */
function stubClient(opts: {
  connections: unknown[];
  snapshot: { data: unknown; error: unknown };
  history?: { data: unknown; error: unknown };
}) {
  const selects: Record<string, string[]> = {};
  const client = {
    selects,
    from(table: string) {
      const columnsSelected = (selects[table] ??= []);
      const resolved =
        table === "provider_account_snapshots"
          ? (opts.history ?? { data: [], error: null })
          : { data: opts.connections, error: null };
      const builder = {
        select(columns: string) {
          columnsSelected.push(columns);
          return builder;
        },
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => opts.snapshot,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(resolved).then(resolve, reject)
      };
      return builder;
    }
  };
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgId.mockResolvedValue("org-uuid");
});

describe("GET /api/orgs/[orgId]/provider-connections", () => {
  it("404s an outsider exactly like an absent org, never a 403", async () => {
    requireOrgId.mockRejectedValue(new DataSourceNotFoundError("Organization not found: org-1"));

    const response = await GET(request as never, context());

    expect(response.status).toBe(404);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("lists every provider once, connected state and snapshot included, never a secret", async () => {
    const client = stubClient({
      connections: [ANTHROPIC_ROW],
      snapshot: { data: SNAPSHOT, error: null }
    });
    createServerSupabaseClient.mockResolvedValue(client);

    const response = await GET(request as never, context());
    const payload = (await response.json()) as { connections: Record<string, unknown>[] };

    expect(response.status).toBe(200);
    // Every connectable provider appears exactly once, connected or not, so
    // clients (and KeyHub's "hook up" rows) never need a second catalog call.
    expect(payload.connections.map((c) => c.provider)).toEqual([...MODEL_PROVIDERS]);

    const anthropic = payload.connections.find((c) => c.provider === "anthropic");
    expect(anthropic).toEqual({
      ...ANTHROPIC_ROW,
      connected: true,
      latest_snapshot: SNAPSHOT
    });
    // The optional admin-key last4 rides the listing (KeyHub's admin-key slot).
    expect(anthropic?.spend_credential_last4).toBe("cd34");

    const openai = payload.connections.find((c) => c.provider === "openai");
    expect(openai).toEqual({
      provider: "openai",
      connected: false,
      config: null,
      credential_last4: null,
      spend_credential_last4: null,
      updated_at: null,
      status: "unchecked",
      status_detail: null,
      status_checked_at: null,
      status_source: null,
      declared_balance_usd: null,
      declared_balance_set_at: null,
      metered_spend_usd: 0,
      low_balance_threshold_usd: 5,
      latest_snapshot: null
    });

    // The no-secrets contract: the read never selects the Vault pointer and
    // nothing secret-shaped reaches the body.
    for (const columns of client.selects.provider_connections ?? []) {
      expect(columns).not.toContain("vault_secret_id");
    }
    expect(JSON.stringify(payload)).not.toContain("vault_secret");
    // Snapshots are read only for connected providers: one connection, one read.
    expect(client.selects.provider_account_snapshots).toHaveLength(1);
  });

  it("?history=N returns an oldest→newest snapshot series per connected provider", async () => {
    const client = stubClient({
      connections: [ANTHROPIC_ROW],
      snapshot: { data: SNAPSHOT, error: null },
      history: { data: HISTORY_NEWEST_FIRST, error: null }
    });
    createServerSupabaseClient.mockResolvedValue(client);

    const withHistory = new Request(
      "http://localhost/api/orgs/org-1/provider-connections?history=30"
    );
    const response = await GET(withHistory as never, context());
    const payload = (await response.json()) as {
      connections: { provider: string; connected: boolean; history: { taken_at: string }[] }[];
    };

    expect(response.status).toBe(200);
    const anthropic = payload.connections.find((c) => c.provider === "anthropic");
    // Reversed from the DB's newest-first read so the sparkline reads left→right.
    expect(anthropic?.history.map((point) => point.taken_at)).toEqual([
      "2026-08-18T09:00:00Z",
      "2026-08-19T09:00:00Z"
    ]);
    // Unconnected providers carry an empty series, never a snapshot read.
    const openai = payload.connections.find((c) => c.provider === "openai");
    expect(openai?.connected).toBe(false);
    expect(openai?.history).toEqual([]);
  });

  it("400s a malformed ?history, including non-decimal syntax Number would coerce", async () => {
    createServerSupabaseClient.mockResolvedValue(
      stubClient({ connections: [], snapshot: { data: null, error: null } })
    );
    // -2/1.5/abc are obviously bad; 1e2 and 0x10 are the traps Number() would
    // otherwise coerce to a passing integer; 0 is below the positive floor.
    for (const bad of ["-2", "1.5", "abc", "1e2", "0x10", "0", ""]) {
      const response = await GET(
        new Request(
          `http://localhost/api/orgs/org-1/provider-connections?history=${encodeURIComponent(bad)}`
        ) as never,
        context()
      );
      expect(response.status).toBe(400);
    }
  });
});
