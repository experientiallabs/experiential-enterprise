import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const findAuthorizedOrg = vi.hoisted(() =>
  vi.fn(async (identifier: string) =>
    identifier === "acme" ? { id: "id-a", slug: "acme", name: "Acme" } : null
  )
);
vi.mock("@/lib/active-org", () => ({
  ACTIVE_ORG_COOKIE: "explabs-active-org",
  findAuthorizedOrg
}));

import { POST } from "@/app/api/active-org/route";

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/active-org", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

describe("POST /api/active-org", () => {
  it("rejects a body without an org identifier", async () => {
    const response = await POST(post({}));
    expect(response.status).toBe(400);
  });

  it("404s an org the session may not access", async () => {
    const response = await POST(post({ org: "not-mine" }));
    expect(response.status).toBe(404);
  });

  it("sets the httpOnly active-org cookie for an authorized org", async () => {
    const response = await POST(post({ org: "acme" }));
    expect(response.status).toBe(200);
    const cookie = response.cookies.get("explabs-active-org");
    expect(cookie?.value).toBe("acme");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
  });
});
