// @vitest-environment node
// (NextRequest/NextResponse.next() require undici's Headers; jsdom's differ.)
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getClaims = vi.hoisted(() => vi.fn());
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims } })
}));
vi.mock("@/lib/auth/config", () => ({
  loadSupabaseAuthSettings: () => ({ url: "http://supabase.local", anonKey: "anon-key" })
}));
vi.mock("@/lib/auth/cookies", () => ({ hasSupabaseAuthCookie: () => true }));

import { proxy } from "@/proxy";

function request(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

// The signed-in auth-surface bounce: a signed-in user has no business on
// /signin, so the proxy sends them to their destination (or the workspace
// root) — EXCEPT the YC deal variant (/signin?yc=1), whose signed-in render IS
// the product (YcWelcome auto-claims the launch grant). Bouncing it strands the
// claim, which is exactly the "founders signed up via /yc but got no credits"
// incident (regression from #645 dropping the proxy carve-out).
describe("proxy signed-in /signin bounce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null });
  });

  it("still bounces a signed-in user off plain /signin", async () => {
    const response = await proxy(request("http://localhost:3000/signin"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("still honors the next deep link on the bounce", async () => {
    const response = await proxy(request("http://localhost:3000/signin?next=%2Fcredits"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/credits");
  });

  it("does NOT bounce a signed-in user off /signin?yc=1 (the auto-claim surface)", async () => {
    const response = await proxy(request("http://localhost:3000/signin?yc=1"));

    // No redirect: the signed-in YC deal page renders (YcWelcome auto-claims).
    expect(response.status).not.toBe(307);
    expect(response.headers.get("location")).toBeNull();
  });
});
