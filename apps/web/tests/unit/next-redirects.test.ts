import type { Redirect } from "next/dist/lib/load-custom-routes";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

// The standalone Simulation surface is retired. next.config serves permanent
// redirects so every old root or deep bookmark lands on the retained Models door
// before a removed page can render or call an obsolete API.
async function loadRedirects(): Promise<Redirect[]> {
  if (typeof nextConfig.redirects !== "function") {
    throw new Error("next.config must define redirects()");
  }
  return nextConfig.redirects();
}

function find(redirects: Redirect[], source: string): Redirect | undefined {
  return redirects.find((redirect) => redirect.source === source);
}

describe("next.config redirects", () => {
  it("moves Simulation and world-model bookmarks to Models", async () => {
    const redirects = await loadRedirects();
    for (const source of [
      "/simulations",
      "/simulations/:path*",
      "/world-models",
      "/world-models/:path*"
    ]) {
      expect(find(redirects, source)).toEqual({ source, destination: "/models", permanent: true });
    }
  });

  it("lands the legacy public roots (/explore, /wm) on the /models door", async () => {
    const redirects = await loadRedirects();
    // The public door moved to /models (2026-07-29), so a bookmark of either legacy
    // landing root follows it there.
    for (const source of ["/explore", "/wm"]) {
      expect(find(redirects, source)).toEqual({ source, destination: "/models", permanent: true });
    }
  });

  it("terminates legacy public deep links at Models", async () => {
    const redirects = await loadRedirects();
    for (const source of ["/explore/:path*", "/wm/:path*"]) {
      expect(find(redirects, source)).toEqual({
        source,
        destination: "/models",
        permanent: true
      });
    }
  });

  it("keeps every moved-path redirect permanent (308, not 307)", async () => {
    const redirects = await loadRedirects();
    for (const source of [
      "/world-models",
      "/world-models/:path*",
      "/simulations",
      "/simulations/:path*",
      "/explore",
      "/explore/:path*",
      "/wm",
      "/wm/:path*"
    ]) {
      expect(find(redirects, source)?.permanent).toBe(true);
    }
  });
});
