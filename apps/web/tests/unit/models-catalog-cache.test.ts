import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The models storefront must serve one SHARED, cross-user cache of the public
// catalog — not a per-visit refetch — so a warm visit renders with no loading
// skeleton, and a background/on-demand revalidation updates the served set for
// everyone. These suites pin that caching contract:
//   * fetchPublicCatalog is registered as a shared Data Cache entry with a
//     bounded revalidate window and the catalog tag (not a no-store per-request
//     read);
//   * a warm second visit is served from that cache without a second backend
//     round trip (the mechanism behind "no skeleton on every visit");
//   * revalidateModelsCatalog busts the tag and the next visit serves the new
//     set;
//   * a signed-in viewer's own models overlay the shared base with a thin
//     per-user read, and org-scoped rows never leak into the shared cache.

const getAuthenticatedUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));

// A memoizing stand-in for Next's Data Cache: unstable_cache stores the result
// under its key across calls (cross-visit shared serving), and revalidateTag
// clears it (on-demand background refresh).
const revalidateTagSpy = vi.hoisted(() => vi.fn());
const unstableCacheCalls = vi.hoisted(
  () => [] as Array<{ keys: string[]; options: { revalidate?: number; tags?: string[] } }>
);
const cacheStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keys: string[],
    options: { revalidate?: number; tags?: string[] }
  ) => {
    unstableCacheCalls.push({ keys, options });
    return async (...args: unknown[]) => {
      const key = keys.join(":");
      if (!cacheStore.has(key)) {
        cacheStore.set(key, await fn(...args));
      }
      return cacheStore.get(key);
    };
  },
  revalidateTag: (tag: string) => {
    cacheStore.clear();
    revalidateTagSpy(tag);
  }
}));

import {
  MODELS_CATALOG_REVALIDATE_SECONDS,
  MODELS_CATALOG_TAG,
  fetchModelList,
  revalidateModelsCatalog
} from "@/lib/models-catalog/server";

type Entry = { model: { id: string; slug: string; owning_org_id: string | null } };

function entry(id: string, owningOrgId: string | null = null): Entry {
  return { model: { id, slug: id, owning_org_id: owningOrgId } };
}

function page(models: Entry[]): Response {
  return Response.json({ models, total: models.length, limit: 1000, offset: 0 });
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
  revalidateTagSpy.mockReset();
  cacheStore.clear();
});

describe("shared public catalog cache", () => {
  it("registers the public catalog as a shared Data Cache entry, not a per-request read", () => {
    // The module registers fetchPublicCatalog at import; assert its shared-cache
    // configuration: a bounded revalidate window and the catalog tag.
    const registration = unstableCacheCalls.find((call) =>
      call.options.tags?.includes(MODELS_CATALOG_TAG)
    );
    expect(registration).toBeDefined();
    expect(registration?.options.revalidate).toBe(MODELS_CATALOG_REVALIDATE_SECONDS);
  });

  it("serves a warm visit from the shared cache without refetching the backend", async () => {
    fetchMock.mockResolvedValue(page([entry("a"), entry("b")]));

    const first = await fetchModelList();
    const second = await fetchModelList();

    // Two visits, one backend round trip: the second is served warm from the
    // shared cache, so it never suspends on a fetch (no loading skeleton).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.models.map((m) => m.model.slug)).toEqual(["a", "b"]);
    expect(second.models.map((m) => m.model.slug)).toEqual(["a", "b"]);
    // The shared cache is org-agnostic: its read carries no actor header.
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["X-Explabs-Actor-Id"]).toBeUndefined();
  });

  it("picks up new models across all visitors after an on-demand revalidation", async () => {
    fetchMock.mockResolvedValueOnce(page([entry("a")]));
    expect((await fetchModelList()).models.map((m) => m.model.slug)).toEqual(["a"]);

    // A catalog write busts the tag; the next visit serves the refreshed set.
    fetchMock.mockResolvedValueOnce(page([entry("a"), entry("b")]));
    revalidateModelsCatalog();

    expect(revalidateTagSpy).toHaveBeenCalledWith(MODELS_CATALOG_TAG);
    expect((await fetchModelList()).models.map((m) => m.model.slug)).toEqual(["a", "b"]);
  });

  it("cools down after a failed refresh instead of stampeding the backend", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      await expect(fetchModelList()).rejects.toThrow();
      // Every retry inside the cooldown fails fast with NO backend call: a
      // dead backend sees at most one catalog probe per window per pod, so an
      // outage cannot become a self-sustaining revalidation herd (2026-08-22).
      cacheStore.clear();
      await expect(fetchModelList()).rejects.toThrow();
      await expect(fetchModelList()).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // After the cooldown the next visit probes the backend again and a
      // recovered backend serves normally.
      vi.advanceTimersByTime(31_000);
      cacheStore.clear();
      fetchMock.mockResolvedValue(page([entry("a")]));
      expect((await fetchModelList()).models.map((m) => m.model.slug)).toEqual(["a"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlays a signed-in viewer's own models without leaking them into the shared cache", async () => {
    getAuthenticatedUser.mockResolvedValue({ id: "user-1" });
    // The shared base (public) and the per-user overlay (owner=org).
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("owner=org")) {
        return Promise.resolve(page([entry("org-model", "org-1")]));
      }
      return Promise.resolve(page([entry("a"), entry("b")]));
    });

    const first = await fetchModelList();
    expect(first.models.map((m) => m.model.slug)).toEqual(["a", "b", "org-model"]);

    // A second signed-in visit reuses the cached public base (still one public
    // read) but refetches the thin per-user overlay: org rows are never cached.
    const second = await fetchModelList();
    expect(second.models.map((m) => m.model.slug)).toEqual(["a", "b", "org-model"]);
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.filter((url) => !url.includes("owner=org"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("owner=org"))).toHaveLength(2);

    // The public base read never carried the actor header (no org leak); the
    // overlay read did.
    const baseCall = fetchMock.mock.calls.find(([url]) => !String(url).includes("owner=org")) as [
      string,
      { headers: Record<string, string> }
    ];
    const overlayCall = fetchMock.mock.calls.find(([url]) => String(url).includes("owner=org")) as [
      string,
      { headers: Record<string, string> }
    ];
    expect(baseCall[1].headers["X-Explabs-Actor-Id"]).toBeUndefined();
    expect(overlayCall[1].headers["X-Explabs-Actor-Id"]).toBe("user-1");
  });
});
