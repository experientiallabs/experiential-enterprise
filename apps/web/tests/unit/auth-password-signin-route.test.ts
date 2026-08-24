import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest, NextResponse } from "next/server";

const createRouteSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/server")>()),
  createRouteSupabaseClient
}));

import { POST } from "@/app/auth/password/signin/route";

function request(body: unknown) {
  return new Request("http://localhost/auth/password/signin", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }) as NextRequest;
}

describe("POST /auth/password/signin", () => {
  const auth = { signInWithPassword: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    createRouteSupabaseClient.mockImplementation((_req: NextRequest, _res: NextResponse) => ({
      auth
    }));
  });

  it("signs in with a valid email + password", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });

    const response = await POST(request({ email: "founder@company.com", password: "hunter2xx" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, created: false });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: "founder@company.com",
      password: "hunter2xx"
    });
  });

  it("returns a uniform 401 for wrong credentials (no existence oracle)", async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "Invalid login credentials", status: 400 }
    });

    const response = await POST(request({ email: "founder@company.com", password: "nope" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_credentials",
      error: "Invalid email or password."
    });
  });

  it("rejects a malformed email before touching GoTrue", async () => {
    const response = await POST(request({ email: "not-an-email", password: "hunter2xx" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("rejects a missing password", async () => {
    const response = await POST(request({ email: "founder@company.com" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});
