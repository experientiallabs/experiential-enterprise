import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWelcomeData } from "@/components/auth/welcome-data";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org: { id: "org-1", slug: "acme" },
    apiKey: null,
    canManageKeys: true,
    credit: { grantedUsd: 20, billableUsd: 0 },
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWelcomeData (the success step's one endpoint seam)", () => {
  it("shows an existing key's prefix without minting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, summary({ apiKey: { keyPrefix: "xpl_ab12cd34" } })));
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchWelcomeData();

    expect(data).toEqual({
      mintedSecret: null,
      keyPrefix: "xpl_ab12cd34",
      grantedUsd: 20,
      canManageKeys: true,
      isYcCompany: false
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes the org's YC-company flag through for the modal's co-branding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, summary({ apiKey: { keyPrefix: "xpl_ab12cd34" }, isYcCompany: true }))
      )
    );
    expect((await fetchWelcomeData())?.isYcCompany).toBe(true);
  });

  it("mints the workspace's first key through the existing mint route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, summary()))
      .mockResolvedValueOnce(
        jsonResponse(200, { apiKey: { id: "key-1" }, secret: "xpl_" + "f".repeat(40) })
      );
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchWelcomeData();

    expect(data?.mintedSecret).toBe("xpl_" + "f".repeat(40));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/keys");
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      orgId: "org-1",
      name: "default",
      expiresInDays: null
    });
  });

  it("force-mints a fresh key on re-trigger even when the org already holds one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, summary({ apiKey: { keyPrefix: "xpl_ab12cd34" } }))
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { apiKey: { id: "key-2" }, secret: "xpl_" + "e".repeat(40) })
      );
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchWelcomeData(true);

    expect(data?.mintedSecret).toBe("xpl_" + "e".repeat(40));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/keys");
  });

  it("never mints for a plain member and still reports the grant", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, summary({ canManageKeys: false })));
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchWelcomeData();

    expect(data).toEqual({
      mintedSecret: null,
      keyPrefix: null,
      grantedUsd: 20,
      canManageKeys: false,
      isYcCompany: false
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the credits line once the org has spent anything (ledger-gated)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        200,
        summary({
          apiKey: { keyPrefix: "xpl_ab12cd34" },
          credit: { grantedUsd: 20, billableUsd: 0.01 }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchWelcomeData())?.grantedUsd).toBeNull();
  });

  it("degrades to null on an error status or a malformed payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, { code: "no_org" })));
    expect(await fetchWelcomeData()).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { org: {} })));
    expect(await fetchWelcomeData()).toBeNull();
  });

  it("keeps the step alive when the mint itself fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, summary()))
      .mockResolvedValueOnce(jsonResponse(403, { error: "Only organization admins." }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchWelcomeData();

    expect(data).toEqual({
      mintedSecret: null,
      keyPrefix: null,
      grantedUsd: 20,
      canManageKeys: true,
      isYcCompany: false
    });
  });
});
