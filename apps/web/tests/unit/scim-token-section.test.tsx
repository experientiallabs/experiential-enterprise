import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScimTokenSection } from "@/components/settings/ScimTokenSection";
import type { ScimTokenStatus } from "@/lib/scim";

const ORG_ID = "org-scim-test";
const BASE_URL = "https://api.example.com/scim/v2";

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

const EMPTY_STATUS: ScimTokenStatus = {
  exists: false,
  last4: null,
  created_at: null,
  revoked_at: null,
  key_policy: null
};

const LIVE_STATUS: ScimTokenStatus = {
  exists: true,
  last4: "ab12",
  created_at: "2026-08-01T00:00:00Z",
  revoked_at: null,
  key_policy: "revoke"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ScimTokenSection", () => {
  it("mints a token and shows the secret once", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    let status: ScimTokenStatus = EMPTY_STATUS;
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, body: init?.body });
      if (method === "POST") {
        status = LIVE_STATUS;
        return jsonResponse({
          token: "xplscim_test_secret_ab12",
          last4: "ab12",
          created_at: "2026-08-01T00:00:00Z",
          key_policy: "revoke"
        });
      }
      return jsonResponse(status);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ScimTokenSection orgId={ORG_ID} scimBaseUrl={BASE_URL} />);
    await screen.findByText(/No SCIM token yet/);

    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));

    expect(await screen.findByText("xplscim_test_secret_ab12")).toBeInTheDocument();
    expect(
      screen.getByText("Copy your SCIM token now — it is shown only once.")
    ).toBeInTheDocument();
    expect(await screen.findByText("xplscim_…ab12")).toBeInTheDocument();
    const mint = calls.find((call) => call.method === "POST");
    expect(mint?.url).toBe(`/api/orgs/${ORG_ID}/scim-token`);
    expect(JSON.parse(mint?.body ?? "{}")).toEqual({ key_policy: "revoke" });
  });

  it("revokes behind the confirm dialog", async () => {
    let status: ScimTokenStatus = LIVE_STATUS;
    const fetchMock = vi.fn(async (_input: unknown, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        status = { ...LIVE_STATUS, revoked_at: "2026-08-02T00:00:00Z" };
        return jsonResponse(status);
      }
      return jsonResponse(status);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ScimTokenSection orgId={ORG_ID} scimBaseUrl={BASE_URL} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke token" }));

    expect(await screen.findByText("revoked")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("shows the IdP base URL and honest group-sync status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(EMPTY_STATUS))
    );
    render(<ScimTokenSection orgId={ORG_ID} scimBaseUrl={BASE_URL} />);
    expect(await screen.findByText(BASE_URL)).toBeInTheDocument();
    expect(screen.getByText(/group sync is\s+not yet available/)).toBeInTheDocument();
  });
});
