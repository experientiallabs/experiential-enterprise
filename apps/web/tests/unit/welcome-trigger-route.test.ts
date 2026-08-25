import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const requireAuthorizedOrgIds = vi.hoisted(() => vi.fn());
const resolveActiveOrg = vi.hoisted(() => vi.fn());
const readLaunchGrantUsd = vi.hoisted(() => vi.fn());
const orgIsYcCompany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/server")>("@/lib/auth/server");
  return { ...actual, createServerSupabaseClient, requireAuthenticatedUser };
});
vi.mock("@/lib/auth/orgs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/orgs")>("@/lib/auth/orgs");
  return { ...actual, requireAuthorizedOrgIds };
});
vi.mock("@/lib/active-org", () => ({ resolveActiveOrg }));
vi.mock("@/lib/billing/launch-grant", () => ({ readLaunchGrantUsd }));
vi.mock("@/lib/billing/tool-accounts-server", () => ({ orgIsYcCompany }));

import { POST } from "@/app/api/account/welcome-trigger/route";

type TriggerRow = {
  active: boolean;
  display_credit_usd: number | null;
  show_api_key: boolean;
  triggered_at: string;
} | null;
type ClaimResult = { data: boolean | null; error: { message: string } | null };

/**
 * Client double: the org_welcome_trigger read plus the atomic
 * claim_welcome_trigger_showing rpc that both marks-seen and reports the winner.
 */
function supabaseClient(
  trigger: TriggerRow,
  claim: ClaimResult = { data: true, error: null }
) {
  const rpc = vi.fn().mockResolvedValue(claim);
  const from = vi.fn((_table: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: trigger }) }) })
  }));
  return { from, rpc };
}

const ARMED: TriggerRow = {
  active: true,
  display_credit_usd: 526,
  show_api_key: true,
  triggered_at: "2026-08-24T00:00:00Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireAuthorizedOrgIds.mockResolvedValue(new Set(["org-1"]));
  resolveActiveOrg.mockResolvedValue({ id: "org-1", slug: "org-1" });
  readLaunchGrantUsd.mockResolvedValue(20);
  orgIsYcCompany.mockResolvedValue(false);
});

describe("POST /api/account/welcome-trigger", () => {
  it("shows and claims when armed and the atomic claim wins", async () => {
    const client = supabaseClient(ARMED, { data: true, error: null });
    createServerSupabaseClient.mockResolvedValue(client);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      show: true,
      displayCreditUsd: 526,
      showApiKey: true,
      isYcCompany: false
    });
    expect(client.rpc).toHaveBeenCalledWith("claim_welcome_trigger_showing", {
      in_org: "org-1",
      in_triggered_at: "2026-08-24T00:00:00Z"
    });
  });

  it("falls back to the launch grant when the amount is null", async () => {
    const client = supabaseClient({ ...ARMED, display_credit_usd: null });
    createServerSupabaseClient.mockResolvedValue(client);

    expect(await (await POST()).json()).toEqual({
      show: true,
      displayCreditUsd: 20,
      showApiKey: true,
      isYcCompany: false
    });
  });

  it("carries the YC-company flag on the show payload", async () => {
    const client = supabaseClient(ARMED);
    createServerSupabaseClient.mockResolvedValue(client);
    orgIsYcCompany.mockResolvedValue(true);

    expect((await (await POST()).json()).isYcCompany).toBe(true);
  });

  it("is silent when the trigger is disarmed", async () => {
    const client = supabaseClient({ ...ARMED, active: false });
    createServerSupabaseClient.mockResolvedValue(client);

    expect(await (await POST()).json()).toEqual({
      show: false,
      displayCreditUsd: null,
      showApiKey: false
    });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("is silent when the atomic claim reports a lost race (already seen)", async () => {
    const client = supabaseClient(ARMED, { data: false, error: null });
    createServerSupabaseClient.mockResolvedValue(client);

    expect((await (await POST()).json()).show).toBe(false);
  });

  it("does not spend the show when the claim rpc errors", async () => {
    const client = supabaseClient(ARMED, { data: null, error: { message: "denied" } });
    createServerSupabaseClient.mockResolvedValue(client);

    expect((await (await POST()).json()).show).toBe(false);
  });

  it("degrades silently for a memberless session", async () => {
    requireAuthorizedOrgIds.mockResolvedValue(new Set());

    expect(await (await POST()).json()).toEqual({
      show: false,
      displayCreditUsd: null,
      showApiKey: false
    });
    expect(resolveActiveOrg).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller through jsonError", async () => {
    const { AuthRequiredError } = await vi.importActual<typeof import("@/lib/auth/server")>(
      "@/lib/auth/server"
    );
    requireAuthenticatedUser.mockRejectedValue(new AuthRequiredError());

    expect((await POST()).status).toBe(401);
  });
});
