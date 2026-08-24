import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));

import {
  isOrgSpendUnlocked,
  spendUnlockRequirement,
  unlockSpendForOrg,
  unlockSpendForUser,
  unlockSpendOnCardSaved,
  unlockSpendOnInboxProof
} from "@/lib/auth/spend-unlock";

// A chainable, thenable Supabase query stub for the organizations read: every
// builder method returns the same builder, and awaiting a terminal (maybeSingle)
// resolves to the configured result.
type QueryResult = { data: unknown; error: unknown };
function makeAdmin(results: Record<string, QueryResult>) {
  const from = vi.fn((table: string) => {
    const result = results[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "maybeSingle"]) {
      builder[method] = vi.fn(() => builder);
    }
    // Thenable so `await builder.…maybeSingle()` resolves.
    builder.then = (resolve: (value: QueryResult) => unknown) => resolve(result);
    return builder;
  });
  return { client: { from } as unknown as SupabaseClient, from };
}

describe("unlockSpendForUser", () => {
  it("delegates to the founder-scoped unlock_founder_spend RPC", async () => {
    // The founder scope (earliest admin membership) lives in the definer
    // function, so the web layer just names it with the proving user's id.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await unlockSpendForUser({ rpc } as unknown as SupabaseClient, "user-1");
    expect(rpc).toHaveBeenCalledWith("unlock_founder_spend", { p_user_id: "user-1" });
  });

  it("never throws when the RPC errors (best-effort)", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      unlockSpendForUser({ rpc } as unknown as SupabaseClient, "user-1")
    ).resolves.toBeUndefined();
  });
});

describe("isOrgSpendUnlocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is false while spend_unlocked_at is null (spend gated)", async () => {
    const admin = makeAdmin({ organizations: { data: { spend_unlocked_at: null }, error: null } });
    createServiceRoleSupabaseClient.mockReturnValue(admin.client);

    expect(await isOrgSpendUnlocked("org-1")).toBe(false);
  });

  it("is true once spend_unlocked_at is set", async () => {
    const admin = makeAdmin({
      organizations: { data: { spend_unlocked_at: "2026-08-26T00:00:00Z" }, error: null }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin.client);

    expect(await isOrgSpendUnlocked("org-1")).toBe(true);
  });

  it("fails open (true) so a read hiccup never nags an unlocked org", async () => {
    const admin = makeAdmin({ organizations: { data: null, error: new Error("down") } });
    createServiceRoleSupabaseClient.mockReturnValue(admin.client);

    expect(await isOrgSpendUnlocked("org-1")).toBe(true);
  });
});

// Build a service-role admin stub exposing BOTH the app_settings read and rpc,
// for the mode-aware unlock routers.
function makeModeAdmin(mode: QueryResult, rpc = vi.fn().mockResolvedValue({ data: null, error: null })) {
  const admin = makeAdmin({ app_settings: mode });
  return { client: { from: admin.from, rpc } as unknown as SupabaseClient, rpc };
}

describe("spendUnlockRequirement", () => {
  it("reads 'card' from the flag", async () => {
    const admin = makeModeAdmin({ data: { spend_unlock_requirement: "card" }, error: null });
    expect(await spendUnlockRequirement(admin.client)).toBe("card");
  });

  it("defaults to 'email' when the row is missing", async () => {
    const admin = makeModeAdmin({ data: null, error: null });
    expect(await spendUnlockRequirement(admin.client)).toBe("email");
  });

  it("falls back to 'email' on an out-of-contract value (a bad manual write)", async () => {
    const admin = makeModeAdmin({ data: { spend_unlock_requirement: "bogus" }, error: null });
    expect(await spendUnlockRequirement(admin.client)).toBe("email");
  });

  it("falls back to 'email' when the settings read errors", async () => {
    const admin = makeModeAdmin({ data: null, error: new Error("down") });
    expect(await spendUnlockRequirement(admin.client)).toBe("email");
  });
});

describe("unlockSpendForOrg", () => {
  it("delegates to the org-scoped unlock_org_spend RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await unlockSpendForOrg({ rpc } as unknown as SupabaseClient, "org-1");
    expect(rpc).toHaveBeenCalledWith("unlock_org_spend", { p_org_id: "org-1" });
  });

  it("never throws when the RPC errors (best-effort)", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      unlockSpendForOrg({ rpc } as unknown as SupabaseClient, "org-1")
    ).resolves.toBeUndefined();
  });
});

describe("unlockSpendOnInboxProof (mode-aware)", () => {
  it("unlocks the founder org via inbox proof in the default 'email' mode", async () => {
    const admin = makeModeAdmin({ data: { spend_unlock_requirement: "email" }, error: null });
    await unlockSpendOnInboxProof(admin.client, "user-1");
    expect(admin.rpc).toHaveBeenCalledWith("unlock_founder_spend", { p_user_id: "user-1" });
  });

  it("does NOT unlock via inbox proof in 'card' mode (a card is required)", async () => {
    const admin = makeModeAdmin({ data: { spend_unlock_requirement: "card" }, error: null });
    await unlockSpendOnInboxProof(admin.client, "user-1");
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});

describe("unlockSpendOnCardSaved (mode-aware)", () => {
  it("unlocks the org when a card is saved in 'card' mode", async () => {
    const admin = makeModeAdmin({ data: { spend_unlock_requirement: "card" }, error: null });
    await unlockSpendOnCardSaved(admin.client, "org-1");
    expect(admin.rpc).toHaveBeenCalledWith("unlock_org_spend", { p_org_id: "org-1" });
  });

  it("does NOT unlock on a saved card in the default 'email' mode (no change today)", async () => {
    const admin = makeModeAdmin({ data: { spend_unlock_requirement: "email" }, error: null });
    await unlockSpendOnCardSaved(admin.client, "org-1");
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
