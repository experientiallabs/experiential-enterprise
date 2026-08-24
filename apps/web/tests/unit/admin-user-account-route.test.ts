import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));

import { DELETE, PATCH } from "@/app/api/admin/users/[userId]/route";

const context = { params: Promise.resolve({ userId: "user-1" }) };

function patchRequest(body: unknown = { email: "renamed@example.com" }) {
  return new Request("https://platform.example/api/admin/users/user-1", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
}

function deleteRequest() {
  return new Request("https://platform.example/api/admin/users/user-1", { method: "DELETE" });
}

function adminClient({
  userExists = true,
  updateError = null as { message: string; status?: number } | null
} = {}) {
  return {
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue(
          userExists
            ? { data: { user: { id: "user-1", email: "old@example.com" } }, error: null }
            : { data: { user: null }, error: { message: "missing" } }
        ),
        updateUserById: vi.fn().mockResolvedValue(
          updateError
            ? { data: { user: null }, error: updateError }
            : { data: { user: { id: "user-1" } }, error: null }
        ),
        deleteUser: vi.fn().mockResolvedValue({ data: {}, error: null })
      }
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  requireAuthenticatedUser.mockResolvedValue({ id: "operator-1" });
});

describe("PATCH /api/admin/users/[userId]", () => {
  it("hides the endpoint from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await PATCH(patchRequest() as never, context);

    expect(response.status).toBe(404);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("changes the email through GoTrue without triggering any confirmation mail", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PATCH(patchRequest({ email: "  Renamed@Example.com " }) as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "user-1",
      email: "renamed@example.com"
    });
    // email_confirm keeps the account confirmed for sign-in; GoTrue's admin
    // update path never calls the mailer, so no address gets an email.
    expect(client.auth.admin.updateUserById).toHaveBeenCalledWith("user-1", {
      email: "renamed@example.com",
      email_confirm: true
    });
  });

  it.each([
    ["missing", {}],
    ["blank", { email: "   " }],
    ["not an address", { email: "nope" }],
    ["inner whitespace", { email: "a b@example.com" }],
    ["wrong type", { email: 7 }]
  ])("rejects a %s email with 400", async (_label, body) => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PATCH(patchRequest(body) as never, context);

    expect(response.status).toBe(400);
    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it("rejects unknown accounts without updating", async () => {
    const client = adminClient({ userExists: false });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PATCH(patchRequest() as never, context);

    expect(response.status).toBe(404);
    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it("maps GoTrue's duplicate-address 422 to a 409 conflict", async () => {
    const client = adminClient({
      updateError: { message: "Email address already registered by another user", status: 422 }
    });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PATCH(patchRequest({ email: "taken@example.com" }) as never, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Email address already registered by another user"
    });
  });

  it("maps GoTrue's own 400 validation refusal to a 400, not a server error", async () => {
    const client = adminClient({
      updateError: { message: "Unable to validate email address: invalid format", status: 400 }
    });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PATCH(patchRequest({ email: "weird@but-plausible" }) as never, context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to validate email address: invalid format"
    });
  });

  it("surfaces other GoTrue failures as 500", async () => {
    const client = adminClient({ updateError: { message: "GoTrue is down", status: 502 } });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PATCH(patchRequest() as never, context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "GoTrue is down" });
  });
});

describe("DELETE /api/admin/users/[userId]", () => {
  it("hides the endpoint from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await DELETE(deleteRequest() as never, context);

    expect(response.status).toBe(404);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("refuses self-deletion", async () => {
    requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(deleteRequest() as never, context);

    expect(response.status).toBe(409);
    expect(client.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("deletes another account through GoTrue", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(deleteRequest() as never, context);

    expect(response.status).toBe(204);
    expect(client.auth.admin.deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("404s for unknown accounts", async () => {
    const client = adminClient({ userExists: false });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(deleteRequest() as never, context);

    expect(response.status).toBe(404);
    expect(client.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});
