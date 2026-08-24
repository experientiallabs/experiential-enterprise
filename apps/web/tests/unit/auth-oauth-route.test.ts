import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signInWithOAuth = vi.fn();

vi.mock("@/lib/auth/server", () => ({
  createRouteSupabaseClient: () => ({ auth: { signInWithOAuth } })
}));

import { GET } from "@/app/auth/oauth/[provider]/route";

const AUTHORIZE_URL =
  "https://project.supabase.co/auth/v1/authorize?provider=google&redirect_to=x";

function oauthRequest(provider: string): [NextRequest, { params: Promise<{ provider: string }> }] {
  const request = new NextRequest(`http://0.0.0.0:3000/auth/oauth/${provider}?next=%2Fmodels`, {
    headers: {
      host: "0.0.0.0:3000",
      "x-forwarded-host": "app.example.test",
      "x-forwarded-proto": "https"
    }
  });
  return [request, { params: Promise.resolve({ provider }) }];
}

/** GoTrue settings answer: which external providers are configured. */
function stubSettings(external: Record<string, boolean> | "unreachable"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (external === "unreachable") {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify({ external }), { status: 200 });
    })
  );
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  signInWithOAuth.mockResolvedValue({ data: { url: AUTHORIZE_URL }, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("/auth/oauth/[provider]", () => {
  it("bounces a configured provider to GoTrue's authorize URL", async () => {
    stubSettings({ github: true, google: true, email: true });
    const response = await GET(...oauthRequest("google"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(AUTHORIZE_URL);
    // The callback GoTrue redirects back through carries the BROWSER's
    // origin, never the standalone server's 0.0.0.0 bind address.
    const redirectTo = (signInWithOAuth.mock.calls[0][0] as { options: { redirectTo: string } })
      .options.redirectTo;
    expect(redirectTo).toBe("https://app.example.test/auth/callback?next=%2Fmodels");
  });

  it("reports provider_disabled only when GoTrue's settings say so", async () => {
    stubSettings({ github: true, google: false, email: true });
    const response = await GET(...oauthRequest("google"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/signin?error=provider_disabled"
    );
    // Never even starts the dance for a provider GoTrue cannot serve.
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("proceeds with the redirect when the settings check cannot run", async () => {
    // The regression this guards: a configured provider must never be
    // reported disabled because a server-side probe was answered oddly.
    // Unknown means proceed and let the browser's navigation see the truth.
    stubSettings("unreachable");
    const response = await GET(...oauthRequest("google"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(AUTHORIZE_URL);
  });

  it("rejects providers outside the roster without touching GoTrue", async () => {
    stubSettings({ github: true, google: true });
    const response = await GET(...oauthRequest("gitlab"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.test/signin?error=unknown_provider"
    );
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });

  it("reports oauth_failed when GoTrue cannot mint the authorize URL", async () => {
    stubSettings({ github: true, google: true });
    signInWithOAuth.mockResolvedValue({ data: null, error: { message: "nope" } });
    const response = await GET(...oauthRequest("google"));

    expect(response.headers.get("location")).toBe(
      "https://app.example.test/signin?error=oauth_failed"
    );
  });
});
