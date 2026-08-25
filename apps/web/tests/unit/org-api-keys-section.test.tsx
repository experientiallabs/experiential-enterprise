import { fireEvent, render as renderBare, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { OrgApiKeysSection } from "@/components/keys/org-api-keys-section";
import type { ApiKeyRow } from "@/lib/api-keys/types";

// The section calls useLoginModal, so it mounts under the provider the
// workspace layout supplies; `isAuthenticated` drives the gate.
function render(ui: Parameters<typeof renderBare>[0], isAuthenticated = true) {
  return renderBare(<LoginModalProvider isAuthenticated={isAuthenticated}>{ui}</LoginModalProvider>);
}

// The KeyHub store caches per org id at module scope, so every test uses its
// own org to start from a cold cache.
let orgSeed = 0;
function nextOrgId(): string {
  orgSeed += 1;
  return `10000000-0000-0000-0000-0000000000${String(orgSeed).padStart(2, "0")}`;
}

function keyRow(overrides: Partial<ApiKeyRow> & { id: string }): ApiKeyRow {
  return {
    org_id: "org",
    name: "production-server",
    key_prefix: "explabs_k1_ab",
    key_suffix: "f2e1",
    created_at: "2026-08-01T10:00:00Z",
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
    identity_id: null,
    ...overrides
  };
}

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function keysPage(keys: ApiKeyRow[]) {
  return { keys, page: 1, pageCount: 1, total: keys.length };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OrgApiKeysSection", () => {
  it("lists the org's keys from GET /api/keys", async () => {
    const orgId = nextOrgId();
    const fetchMock = vi.fn(async (_input: unknown) =>
      jsonResponse(keysPage([keyRow({ id: "key-1" })]))
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<OrgApiKeysSection canManage orgId={orgId} />);

    expect(await screen.findByText("production-server")).toBeInTheDocument();
    expect(screen.getByText("explabs_k1_ab…f2e1")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/keys?orgId=${orgId}&page=1`);
  });

  it("mints a key, shows the secret once, and refreshes the shared list", async () => {
    const orgId = nextOrgId();
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, body: init?.body });
      if (method === "POST") {
        return jsonResponse({ apiKey: keyRow({ id: "key-2", name: "ci" }), secret: "sk-test-secret" });
      }
      return jsonResponse(keysPage([keyRow({ id: "key-2", name: "ci" })]));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OrgApiKeysSection canManage orgId={orgId} />);
    await screen.findByText("ci");

    fireEvent.change(screen.getByPlaceholderText("e.g. production-server"), {
      target: { value: "ci" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    expect(await screen.findByText("sk-test-secret")).toBeInTheDocument();
    expect(screen.getByText("Copy your key now. It is shown only once.")).toBeInTheDocument();
    const mint = calls.find((call) => call.method === "POST");
    expect(mint?.url).toBe("/api/keys");
    expect(JSON.parse(mint?.body ?? "{}")).toMatchObject({ orgId, name: "ci" });
    // The mint invalidates the shared store, so every mount re-reads.
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThan(1);
    });
  });

  it("revokes softly and surfaces a refusal inline instead of pretending", async () => {
    const orgId = nextOrgId();
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
      if ((init?.method ?? "GET") === "DELETE") {
        return jsonResponse({ error: "Only organization admins can manage API keys." }, false, 403);
      }
      return jsonResponse(keysPage([keyRow({ id: "key-3" })]));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OrgApiKeysSection canManage orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(
      await screen.findByText("Only organization admins can manage API keys.")
    ).toBeInTheDocument();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("/api/keys/key-3");
  });

  it("rotates a key: shows the replacement secret once plus the overlap deadline", async () => {
    const orgId = nextOrgId();
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method });
      if (method === "POST") {
        return jsonResponse({
          apiKey: keyRow({ id: "key-7" }),
          secret: "sk-rotated-secret",
          oldKeyExpiresAt: "2026-08-22T12:00:00Z"
        });
      }
      return jsonResponse(keysPage([keyRow({ id: "key-6" })]));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OrgApiKeysSection canManage orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Rotate" }));

    expect(await screen.findByText("sk-rotated-secret")).toBeInTheDocument();
    expect(screen.getByText("Copy your key now. It is shown only once.")).toBeInTheDocument();
    // The rotation banner explains the overlap window instead of implying a cutover.
    expect(screen.getByText(/The previous key keeps working until/)).toBeInTheDocument();
    const rotate = calls.find((call) => call.method === "POST");
    expect(rotate?.url).toBe("/api/keys/key-6/rotate");
    // The rotation invalidates the shared store, so every mount re-reads.
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThan(1);
    });
  });

  it("surfaces a rotate refusal inline (already-revoked keys 409)", async () => {
    const orgId = nextOrgId();
    const fetchMock = vi.fn(async (_input: unknown, init?: { method?: string }) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonResponse(
          { error: "API key is already revoked; mint a new key instead of rotating." },
          false,
          409
        );
      }
      return jsonResponse(keysPage([keyRow({ id: "key-8" })]));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OrgApiKeysSection canManage orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Rotate" }));
    expect(
      await screen.findByText("API key is already revoked; mint a new key instead of rotating.")
    ).toBeInTheDocument();
  });

  it("labels revoked and expired keys instead of hiding them", async () => {
    stubList([
      keyRow({ id: "key-4", name: "old", revoked_at: "2026-08-02T00:00:00Z" }),
      keyRow({ id: "key-5", name: "stale", expires_at: "2020-01-01T00:00:00Z" })
    ]);
    render(<OrgApiKeysSection canManage={false} orgId={nextOrgId()} />);

    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    // Viewers who cannot manage get no revoke column at all.
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("renders the locked state signed out: one line, one sign-in action, zero fetches", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<OrgApiKeysSection canManage={false} orgId={null} />, false);

    expect(screen.getByText("API keys for calling the gateway live here.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function stubList(keys: ApiKeyRow[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(keysPage(keys)))
  );
}
