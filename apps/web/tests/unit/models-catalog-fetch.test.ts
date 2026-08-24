import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetchModelList joins the catalog past the API's per-request cap. The paging
// math is what these suites pin: the first page reports the total, and the
// remaining pages are fetched by offset and concatenated in order.
const getAuthenticatedUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));
// The paging math is what these suites pin, so the shared Data Cache is a
// pass-through here (its cross-visit behavior is exercised in
// models-catalog-cache.test.ts).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn()
}));

import { fetchModelList } from "@/lib/models-catalog/server";

type Entry = { model: { slug: string } };

function entries(slugs: string[]): Entry[] {
  return slugs.map((slug) => ({ model: { slug } }));
}

function page(models: Entry[], total: number): Response {
  return Response.json({ models, total, limit: 1000, offset: 0 });
}

const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  getAuthenticatedUser.mockResolvedValue(null);
  vi.stubEnv("EXPLABS_BACKEND_URL", "https://backend.test");
  vi.stubEnv("EXPLABS_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("fetchModelList", () => {
  it("returns a single page without asking for more", async () => {
    fetchMock.mockResolvedValueOnce(page(entries(["a", "b"]), 2));
    const result = await fetchModelList();
    expect(result.models.map((m) => m.model.slug)).toEqual(["a", "b"]);
    expect(result.total).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("joins the remaining pages by offset and preserves order", async () => {
    // total=2500 over a 1000-row cap: one first page plus two more, whose
    // offsets (1000, 2000) are both known from the first response.
    const first = entries(Array.from({ length: 1000 }, (_, i) => `m${i}`));
    const second = entries(Array.from({ length: 1000 }, (_, i) => `m${1000 + i}`));
    const third = entries(Array.from({ length: 500 }, (_, i) => `m${2000 + i}`));
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("offset=1000")) {
        return Promise.resolve(page(second, 2500));
      }
      if (url.includes("offset=2000")) {
        return Promise.resolve(page(third, 2500));
      }
      return Promise.resolve(page(first, 2500));
    });
    const result = await fetchModelList();
    expect(result.models).toHaveLength(2500);
    expect(result.models[0].model.slug).toBe("m0");
    expect(result.models[1500].model.slug).toBe("m1500");
    expect(result.models[2499].model.slug).toBe("m2499");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const offsets = fetchMock.mock.calls.map(([url]) => String(url));
    expect(offsets.some((u) => u.includes("offset=1000"))).toBe(true);
    expect(offsets.some((u) => u.includes("offset=2000"))).toBe(true);
  });
});
