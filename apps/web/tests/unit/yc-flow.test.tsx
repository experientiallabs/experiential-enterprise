import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.hoisted(() => vi.fn());
const routerRefresh = vi.hoisted(() => vi.fn());
const searchParamsRef = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/signin",
  useRouter: () => ({ push: routerPush, refresh: routerRefresh, replace: vi.fn() }),
  useSearchParams: () => searchParamsRef.current
}));

const captureTelemetryEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telemetry/client", () => ({ captureTelemetryEvent }));

import YcPage from "@/app/yc/page";
import { SigninForm } from "@/app/signin/SigninForm";
import type { YcClaimState } from "@/lib/types";

// This suite covers the FLOW — the /yc short link and the yc=1 threading
// through every auth path. The signed-in claim surface (YcClaimRedirect) and
// the welcome modal it lands on have their own suites.

const MINTED_KEY = "xpl_ycdeal1234567890";

type FetchScript = {
  claim?: { status: number; payload: unknown };
  welcome?: { status: number; payload: unknown };
  budgetYc?: YcClaimState | null;
};

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function stubYcFetch(script: FetchScript = {}) {
  const mock = vi.fn(async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    if (target === "/api/welcome") {
      const fallback = {
        org: { id: "org-1" },
        apiKey: null,
        canManageKeys: true,
        credit: { grantedUsd: 20, billableUsd: 0 }
      };
      const welcome = script.welcome ?? { status: 200, payload: fallback };
      return jsonResponse(welcome.status, welcome.payload);
    }
    if (target === "/api/orgs/org-1/yc/claim" && init?.method === "POST") {
      const claim = script.claim ?? {
        status: 200,
        payload: { granted_usd: 526, expires_at: "2026-11-19T12:00:00Z", balance_usd: 546 }
      };
      return jsonResponse(claim.status, claim.payload);
    }
    if (target === "/api/orgs/org-1/budget") {
      return jsonResponse(200, { budget: { yc: script.budgetYc ?? null } });
    }
    if (target === "/api/keys" && init?.method === "POST") {
      return jsonResponse(200, { secret: MINTED_KEY });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${target}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  captureTelemetryEvent.mockReset();
  routerPush.mockReset();
  routerRefresh.mockReset();
  searchParamsRef.current = new URLSearchParams();
  document.cookie = "explabs_yc_intent=; max-age=0; path=/";
  window.localStorage.clear();
});

describe("/yc short link", () => {
  it("redirects to the sign-in page's YC variant", () => {
    let digest = "";
    try {
      YcPage();
    } catch (error) {
      digest = String((error as { digest?: unknown }).digest ?? error);
    }
    expect(digest).toContain("/signin?yc=1");
  });
});

describe("SigninForm YC threading", () => {
  it("routes the OAuth round-trip back to /signin?yc=1", () => {
    stubYcFetch();
    render(<SigninForm inviteToken={null} prefillEmail={null} ycDeal />);
    const google = screen.getByRole("link", { name: /google/i });
    expect(google.getAttribute("href")).toContain(encodeURIComponent("/signin?yc=1"));
  });

  it("stays in place after an email-code login so the signed-in render auto-claims", async () => {
    // The code flow's success must refresh /signin?yc=1 (whose signed-in
    // render is YcClaimRedirect, the auto-claim surface) — never navigate away.
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);
      if (target === "/auth/otp") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (target === "/auth/otp/verify") {
        return { ok: true, status: 200, json: async () => ({ ok: true, created: true }) };
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SigninForm inviteToken={null} prefillEmail="founder@company.com" ycDeal />);

    // The prefilled YC arrival auto-sends on mount, so the code stage is
    // already up — no Continue click.
    fireEvent.change(await screen.findByLabelText("Sign-in code"), {
      target: { value: "123456" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("auto-sends the sign-in code on mount for a prefilled YC arrival", async () => {
    // The /yc funnel already collected the founder's email; the form must land
    // them on the code stage, not make them click Continue again.
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url) === "/auth/otp") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SigninForm inviteToken={null} prefillEmail="founder@company.com" ycDeal />);

    expect(await screen.findByLabelText("Sign-in code")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/auth/otp")).toHaveLength(1);
  });

  it("does NOT auto-send for a plain prefilled sign-in (no YC intent)", async () => {
    // Only the YC path auto-sends; a normal ?email= prefill must not email a
    // code to an address the visitor never typed on this origin.
    const fetchMock = vi.fn(async (url: unknown) => {
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SigninForm inviteToken={null} prefillEmail="founder@company.com" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives the YC variant from the URL even without the prop", () => {
    // Fold armor: if a merge ever re-renders SigninForm without ycDeal, the
    // yc query param alone still threads OAuth back to the claim surface.
    stubYcFetch();
    searchParamsRef.current = new URLSearchParams("yc=1");
    render(<SigninForm inviteToken={null} prefillEmail={null} />);

    const google = screen.getByRole("link", { name: /google/i });
    expect(google.getAttribute("href")).toContain(encodeURIComponent("/signin?yc=1"));
  });

  it("routes a generic login with a live YC-intent marker to the claim surface", async () => {
    // The marker survives a redirect slip (the regression the product owner hit live):
    // a code login on the PLAIN form still lands on the claim surface.
    document.cookie = "explabs_yc_intent=1; path=/";
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);
      if (target === "/auth/otp") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (target === "/auth/otp/verify") {
        return { ok: true, status: 200, json: async () => ({ ok: true, created: true }) };
      }
      throw new Error(`Unexpected fetch: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SigninForm inviteToken={null} prefillEmail="founder@company.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("Sign-in code"), {
      target: { value: "123456" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/signin?yc=1"));
  });
});
