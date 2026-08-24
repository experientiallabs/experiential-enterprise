import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const createRouteSupabaseClient = vi.hoisted(() => vi.fn());
const provisionInstantAccount = vi.hoisted(() => vi.fn());
const sendVerificationEmail = vi.hoisted(() => vi.fn());
const sendSigninCode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin, createServiceRoleSupabaseClient }));
vi.mock("@/lib/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/server")>("@/lib/auth/server");
  return { ...actual, createRouteSupabaseClient };
});
vi.mock("@/lib/auth/instant-signup", () => ({ provisionInstantAccount }));
vi.mock("@/lib/auth/verification", () => ({ sendVerificationEmail, sendSigninCode }));

import { POST } from "@/app/api/admin/orgs/route";

type TableCall = { table: string; op: string; payload?: unknown };

/**
 * A chainable service-role stub that records every table write so assertions
 * can prove exactly what was persisted (and, crucially, what was NOT: this
 * route must never write spend_unlocked_at).
 */
function makeAdminClient(results: Record<string, unknown> = {}) {
  const calls: TableCall[] = [];
  const client = {
    calls,
    from(table: string) {
      const record = (op: string, payload?: unknown) => calls.push({ table, op, payload });
      const terminal = (key: string) =>
        Promise.resolve(
          (results[key] as { data?: unknown; error?: unknown } | undefined) ?? {
            data: null,
            error: null
          }
        );
      return {
        update(payload: unknown) {
          record("update", payload);
          return {
            eq: () => ({
              select: () => ({ single: () => terminal(`${table}.update`) })
            })
          };
        },
        insert(payload: unknown) {
          record("insert", payload);
          const promise = terminal(`${table}.insert`);
          return Object.assign(promise, {
            select: () => ({ single: () => terminal(`${table}.insert`) })
          });
        },
        delete() {
          record("delete");
          return { eq: () => terminal(`${table}.delete`) };
        }
      };
    }
  };
  return client;
}

function postRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/admin/orgs", {
    body: JSON.stringify(body),
    // host + x-forwarded-proto let requestOrigin resolve without NextRequest's
    // nextUrl (this plain Request has none).
    headers: {
      "content-type": "application/json",
      host: "platform.example",
      "x-forwarded-proto": "https"
    },
    method: "POST"
  }) as unknown as NextRequest;
}

const NEW_ORG = { id: "org-9", name: "Acme Robotics", slug: "acme-robotics-1a2b3c4d" };

function stubRosterUsers(users: Array<{ id: string; email: string; banned_until?: string | null }>) {
  createRouteSupabaseClient.mockReturnValue({
    rpc: vi.fn(async () => ({
      data: users.map((user) => ({ banned_until: null, ...user })),
      error: null
    }))
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  stubRosterUsers([{ id: "user-77", email: "Founder@Acme.com" }]);
  sendVerificationEmail.mockResolvedValue({ sent: true });
  sendSigninCode.mockResolvedValue(true);
});

describe("POST /api/admin/orgs (create with founder)", () => {
  it("is a not-found for a non-admin and provisions nothing", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await POST(postRequest({ name: "Acme", founder_email: "a@b.com" }));
    expect(response.status).toBe(404);
    expect(provisionInstantAccount).not.toHaveBeenCalled();
  });

  it("rejects a missing founder email with 400 before touching anything", async () => {
    const response = await POST(postRequest({ name: "Acme" }));
    expect(response.status).toBe(400);
    expect(provisionInstantAccount).not.toHaveBeenCalled();
  });

  it("rejects an invalid founder email with 400", async () => {
    const response = await POST(postRequest({ name: "Acme", founder_email: "not-an-email" }));
    expect(response.status).toBe(400);
    expect(provisionInstantAccount).not.toHaveBeenCalled();
  });

  it("NEW email: provisions the account, renames its org, keeps spend locked, emails verification", async () => {
    const admin = makeAdminClient({ "organizations.update": { data: NEW_ORG, error: null } });
    createServiceRoleSupabaseClient.mockReturnValue(admin);
    provisionInstantAccount.mockResolvedValue({
      status: "created",
      userId: "user-1",
      orgId: "org-9",
      apiKeySecret: null,
      creditsGranted: 20,
      sessionPassword: "xpl-ignored"
    });

    const response = await POST(
      postRequest({ name: "Acme Robotics", founder_email: "founder@acme.com" })
    );
    expect(response.status).toBe(201);
    // No API key is minted for the founder here (null keyName).
    expect(provisionInstantAccount).toHaveBeenCalledWith(admin, "founder@acme.com", null, null);
    const update = admin.calls.find((call) => call.op === "update");
    expect(update?.table).toBe("organizations");
    const payload = update?.payload as Record<string, unknown>;
    expect(payload.name).toBe("Acme Robotics");
    expect(payload.slug).toMatch(/^acme-robotics-[0-9a-f]{8}$/);
    // The spend gate MUST hold: this route never writes spend_unlocked_at.
    expect(payload).not.toHaveProperty("spend_unlocked_at");
    expect(sendVerificationEmail).toHaveBeenCalled();
    expect(await response.json()).toEqual({
      organization: NEW_ORG,
      founder: { email: "founder@acme.com", status: "created" },
      verification_email_sent: true
    });
  });

  it("NEW email: a failed rename deletes the just-provisioned org so a retry is clean", async () => {
    const admin = makeAdminClient({
      "organizations.update": { data: null, error: { message: "rename failed" } }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);
    provisionInstantAccount.mockResolvedValue({
      status: "created",
      userId: "user-1",
      orgId: "org-9",
      apiKeySecret: null,
      creditsGranted: 20,
      sessionPassword: "xpl-ignored"
    });

    const response = await POST(
      postRequest({ name: "Acme Robotics", founder_email: "founder@acme.com" })
    );
    expect(response.status).toBe(500);
    // Without this compensation, a retry would take the existing-email branch
    // and mint a second org with a second welcome grant.
    expect(
      admin.calls.some((call) => call.table === "organizations" && call.op === "delete")
    ).toBe(true);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("removed");
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("EXISTING email: creates the org with the user as founding admin and emails a sign-in code", async () => {
    const admin = makeAdminClient({
      "organizations.insert": { data: NEW_ORG, error: null },
      "organization_members.insert": { error: null }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);
    provisionInstantAccount.mockResolvedValue({ status: "account_exists" });

    const response = await POST(
      postRequest({ name: "Acme Robotics", founder_email: "founder@acme.com" })
    );
    expect(response.status).toBe(201);
    const orgInsert = admin.calls.find(
      (call) => call.table === "organizations" && call.op === "insert"
    );
    const orgPayload = orgInsert?.payload as Record<string, unknown>;
    expect(orgPayload.name).toBe("Acme Robotics");
    // Spend gating rides the column default (null); the insert must not set it.
    expect(orgPayload).not.toHaveProperty("spend_unlocked_at");
    // The email matched case-insensitively against the roster RPC.
    const memberInsert = admin.calls.find((call) => call.table === "organization_members");
    expect(memberInsert?.payload).toEqual({
      org_id: "org-9",
      user_id: "user-77",
      role: "admin"
    });
    // An existing address is never auto-verified, but it DOES get an emailed
    // sign-in code: the inbox-proof route that unlocks the org.
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(sendSigninCode).toHaveBeenCalledWith("founder@acme.com", "https://platform.example");
    expect(await response.json()).toEqual({
      organization: NEW_ORG,
      founder: { email: "founder@acme.com", status: "existing" },
      verification_email_sent: true
    });
  });

  it("EXISTING email: refuses a banned founder without creating anything", async () => {
    stubRosterUsers([
      { id: "user-77", email: "founder@acme.com", banned_until: "2099-01-01T00:00:00Z" }
    ]);
    const admin = makeAdminClient();
    createServiceRoleSupabaseClient.mockReturnValue(admin);
    provisionInstantAccount.mockResolvedValue({ status: "account_exists" });

    const response = await POST(
      postRequest({ name: "Acme Robotics", founder_email: "founder@acme.com" })
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("banned");
    expect(admin.calls).toHaveLength(0);
    expect(sendSigninCode).not.toHaveBeenCalled();
  });

  it("EXISTING email: an expired ban does not block creation", async () => {
    stubRosterUsers([
      { id: "user-77", email: "founder@acme.com", banned_until: "2020-01-01T00:00:00Z" }
    ]);
    const admin = makeAdminClient({
      "organizations.insert": { data: NEW_ORG, error: null },
      "organization_members.insert": { error: null }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);
    provisionInstantAccount.mockResolvedValue({ status: "account_exists" });

    const response = await POST(
      postRequest({ name: "Acme Robotics", founder_email: "founder@acme.com" })
    );
    expect(response.status).toBe(201);
  });

  it("EXISTING email: cleans up the org when the membership insert fails, and says so if cleanup fails too", async () => {
    const admin = makeAdminClient({
      "organizations.insert": { data: NEW_ORG, error: null },
      "organization_members.insert": { error: { message: "membership failed" } },
      "organizations.delete": { error: { message: "delete refused" } }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);
    provisionInstantAccount.mockResolvedValue({ status: "account_exists" });

    const response = await POST(
      postRequest({ name: "Acme Robotics", founder_email: "founder@acme.com" })
    );
    expect(response.status).toBe(500);
    expect(
      admin.calls.some((call) => call.table === "organizations" && call.op === "delete")
    ).toBe(true);
    // The failed compensation is surfaced honestly, not swallowed.
    expect((await response.json()).error).toContain("manually");
  });

  it("surfaces a provisioning failure as a 500 with its message", async () => {
    createServiceRoleSupabaseClient.mockReturnValue(makeAdminClient());
    provisionInstantAccount.mockResolvedValue({
      status: "signup_failed",
      message: "Account provisioning did not complete; try again."
    });

    const response = await POST(
      postRequest({ name: "Acme", founder_email: "founder@acme.com" })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Account provisioning did not complete; try again."
    });
  });

  it("maps a service-role configuration fault to a generic 500, never the env-var name", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    createServiceRoleSupabaseClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set for admin operations.");
    });

    const response = await POST(
      postRequest({ name: "Acme", founder_email: "founder@acme.com" })
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Organization creation failed.");
    expect(body.error).not.toContain("SUPABASE");
    consoleError.mockRestore();
  });
});
