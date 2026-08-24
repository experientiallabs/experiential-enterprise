import { afterEach, describe, expect, it, vi } from "vitest";

import { getDataSource } from "@/lib/data-source";

// getDataSource resolves the acting user through the server auth module,
// which reads request cookies; unit tests run without a request scope.
vi.mock("@/lib/auth/server", () => ({
  requireAuthenticatedUser: async () => ({ id: "user-1", email: "user-1@example.com" })
}));

describe("getDataSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends the server-side bearer key and acting user to the configured backend", async () => {
    vi.stubEnv("EXPLABS_BACKEND_URL", "https://api.example.test");
    vi.stubEnv("EXPLABS_API_KEY", "test-api-key");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "00000000-0000-0000-0000-000000000002",
            slug: "demo",
            name: "Demo",
            role: "admin"
          }
        ]),
        { status: 200 }
      )
    );

    await getDataSource().listOrgs();

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/api/orgs", {
      body: undefined,
      cache: "no-store",
      headers: {
        Authorization: "Bearer test-api-key",
        "X-Explabs-Actor-Id": "user-1"
      },
      method: "GET"
    });
  });

  it("requires the backend URL and the bearer key", () => {
    vi.stubEnv("EXPLABS_BACKEND_URL", "");
    vi.stubEnv("EXPLABS_API_KEY", "test-api-key");
    expect(() => getDataSource()).toThrow(/EXPLABS_BACKEND_URL/);

    vi.stubEnv("EXPLABS_BACKEND_URL", "https://api.example.test");
    vi.stubEnv("EXPLABS_API_KEY", "");
    expect(() => getDataSource()).toThrow(/EXPLABS_API_KEY/);
  });
});
