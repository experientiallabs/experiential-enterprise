import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerReplace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace })
}));

import { YcClaimRedirect } from "@/components/yc/YcClaimRedirect";
import { overviewWelcomePath } from "@/lib/routes";

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function hasYcCookie(): boolean {
  return document.cookie.split("; ").includes("explabs_yc_intent=1");
}

afterEach(() => {
  vi.unstubAllGlobals();
  routerReplace.mockReset();
  document.cookie = "explabs_yc_intent=; max-age=0; path=/";
});

describe("YcClaimRedirect", () => {
  it("claims the grant, clears the intent cookie, and redirects to the welcome landing", async () => {
    document.cookie = "explabs_yc_intent=1; path=/";
    const fetchMock = vi.fn(async (url: unknown, init?: { method?: string }) => {
      const target = String(url);
      if (target === "/api/welcome") {
        return jsonResponse(200, { org: { id: "org-1" } });
      }
      if (target === "/api/orgs/org-1/yc/claim" && init?.method === "POST") {
        return jsonResponse(200, { granted_usd: 526 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<YcClaimRedirect />);

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith(overviewWelcomePath()));
    expect(fetchMock).toHaveBeenCalledWith("/api/orgs/org-1/yc/claim", { method: "POST" });
    expect(hasYcCookie()).toBe(false);
  });

  it("treats an idempotent 409 as served: clears the cookie and redirects", async () => {
    document.cookie = "explabs_yc_intent=1; path=/";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const target = String(url);
        if (target === "/api/welcome") {
          return jsonResponse(200, { org: { id: "org-1" } });
        }
        return jsonResponse(409, { code: "yc_already_claimed" });
      })
    );

    render(<YcClaimRedirect />);

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith(overviewWelcomePath()));
    expect(hasYcCookie()).toBe(false);
  });

  it("still redirects but keeps the cookie when the claim fails outright", async () => {
    document.cookie = "explabs_yc_intent=1; path=/";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const target = String(url);
        if (target === "/api/welcome") {
          return jsonResponse(200, { org: { id: "org-1" } });
        }
        return jsonResponse(500, { error: "boom" });
      })
    );

    render(<YcClaimRedirect />);

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith(overviewWelcomePath()));
    // Cookie survives so the Overview guard can retry the claim on the other side.
    expect(hasYcCookie()).toBe(true);
  });

  it("redirects without claiming when no org resolves", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404, { code: "no_org" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<YcClaimRedirect />);

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith(overviewWelcomePath()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
