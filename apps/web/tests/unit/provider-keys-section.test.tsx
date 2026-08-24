import { fireEvent, render as renderBare, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { ProviderKeysSection } from "@/components/keys/provider-keys-section";

// The section calls useLoginModal, so it mounts under the provider the
// workspace layout supplies; `isAuthenticated` drives the gate.
function render(ui: Parameters<typeof renderBare>[0], isAuthenticated = true) {
  return renderBare(<LoginModalProvider isAuthenticated={isAuthenticated}>{ui}</LoginModalProvider>);
}
import { PROVIDER_CONNECTION_STATUSES, type ModelProvider } from "@/lib/model-providers";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";

// The KeyHub store caches per org id at module scope, so every test uses its
// own org to start from a cold cache.
let orgSeed = 0;
function nextOrgId(): string {
  orgSeed += 1;
  return `00000000-0000-0000-0000-0000000000${String(orgSeed).padStart(2, "0")}`;
}

function summary(
  overrides: Partial<ProviderConnectionSummary> & { provider: ModelProvider }
): ProviderConnectionSummary {
  return {
    connected: false,
    config: null,
    credential_last4: null,
    spend_credential_last4: null,
    updated_at: null,
    status: "unchecked",
    status_detail: null,
    status_checked_at: null,
    status_source: null,
    declared_balance_usd: null,
    declared_balance_set_at: null,
    metered_spend_usd: 0,
    low_balance_threshold_usd: 5,
    latest_snapshot: null,
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

/** GETs answer the connection list; mutations are recorded and answer ok. */
function stubFetch(connections: ProviderConnectionSummary[]) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "GET") {
      return jsonResponse({ connections });
    }
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ProviderKeysSection", () => {
  it("renders every canonical status as its own distinct badge", async () => {
    // Six providers, one per status — the enum and the labels move together.
    const providers: ModelProvider[] = [
      "openai",
      "anthropic",
      "gemini",
      "azure_openai",
      "openrouter",
      "bedrock"
    ];
    stubFetch(
      providers.map((provider, index) =>
        summary({
          provider,
          connected: true,
          credential_last4: "1234",
          status: PROVIDER_CONNECTION_STATUSES[index]
        })
      )
    );
    render(<ProviderKeysSection canManage={false} orgId={nextOrgId()} />);

    const labels = [
      "Not verified",
      "Verified",
      "Invalid key",
      "Rate limited",
      "Out of quota",
      "Provider error"
    ];
    expect(labels).toHaveLength(PROVIDER_CONNECTION_STATUSES.length);
    for (const label of labels) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    // Distinct verdicts must not share a rendering: a working key is green,
    // a rejected one red, throttling amber, and our own check failing gray.
    const chipClass = (label: string) => screen.getByText(label).className;
    expect(chipClass("Verified")).not.toBe(chipClass("Invalid key"));
    expect(chipClass("Invalid key")).not.toBe(chipClass("Rate limited"));
    expect(chipClass("Provider error")).not.toBe(chipClass("Not verified"));
  });

  it("states how each connection is hooked up, and what connecting takes for the rest", async () => {
    stubFetch([
      summary({
        provider: "bedrock",
        connected: true,
        credential_last4: "WXYZ",
        config: { region: "us-east-1", access_key_id: "AKIA123456789EXAMPLE" },
        status: "valid"
      }),
      summary({
        provider: "azure_openai",
        connected: true,
        credential_last4: "9f3a",
        config: { endpoint: "https://r.openai.azure.com", deployments: { "gpt-5.5": "prod-55" } },
        status: "valid"
      }),
      summary({ provider: "modal" })
    ]);
    render(<ProviderKeysSection canManage={false} orgId={nextOrgId()} />);

    expect(await screen.findByText("AWS IAM keys (us-east-1)")).toBeInTheDocument();
    expect(screen.getByText("Azure key + 1 deployment")).toBeInTheDocument();
    expect(screen.getByText("····WXYZ")).toBeInTheDocument();
    // The unconnected provider is a quiet hook-up row; expanding it says what
    // connecting takes.
    fireEvent.click(screen.getByRole("button", { name: "Expand Modal details" }));
    expect(
      screen.getByText("Needs a token pair: token id (ak-…) and token secret (as-…).")
    ).toBeInTheDocument();
  });

  it("renders the spend cell honestly per provider capability — never blank", async () => {
    stubFetch([
      summary({
        provider: "openrouter",
        connected: true,
        status: "valid",
        latest_snapshot: {
          taken_at: "2026-08-18T10:00:00Z",
          spend_usd: 12.34,
          credits_remaining_usd: 58,
          usage_limit_usd: 100,
          source: "provider_api"
        }
      }),
      summary({ provider: "gemini", connected: true, status: "valid" }),
      summary({ provider: "anthropic", connected: true, status: "valid" }),
      summary({
        provider: "bedrock",
        connected: true,
        status: "valid",
        declared_balance_usd: 100,
        metered_spend_usd: 12.5
      })
    ]);
    render(<ProviderKeysSection canManage={false} orgId={nextOrgId()} />);

    expect(
      await screen.findByText("$12.34 this month · credits: $58.00 left / limit $100.00")
    ).toBeInTheDocument();
    expect(screen.getByText("Google doesn't report this")).toBeInTheDocument();
    expect(screen.getByText("connect an admin key to see spend")).toBeInTheDocument();
    expect(screen.getByText("self-reported: $87.50 left")).toBeInTheDocument();
  });

  it("expands a row to the verbose stored verdict in the provider's own words", async () => {
    stubFetch([
      summary({
        provider: "anthropic",
        connected: true,
        credential_last4: "ab12",
        status: "invalid",
        status_checked_at: "2026-08-18T10:00:00Z",
        status_source: "hookup_check",
        status_detail: {
          remediation: "Anthropic rejected this key. Paste a current inference key from the Console.",
          provider_message: "authentication_error: invalid x-api-key"
        }
      })
    ]);
    render(<ProviderKeysSection canManage={false} orgId={nextOrgId()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Anthropic" }));
    expect(
      screen.getByText(
        'Anthropic rejected this key. Paste a current inference key from the Console. (Provider said: "authentication_error: invalid x-api-key")'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/at hookup/)).toBeInTheDocument();
  });

  it("disconnects through the house ConfirmDialog, never window.confirm", async () => {
    const orgId = nextOrgId();
    const { calls } = stubFetch([
      summary({ provider: "openai", connected: true, credential_last4: "44ff", status: "valid" })
    ]);
    const nativeConfirm = vi.spyOn(window, "confirm");
    render(<ProviderKeysSection canManage orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: "OpenAI" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Disconnect OpenAI?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await vi.waitFor(() => {
      const del = calls.find((call) => call.method === "DELETE");
      expect(del?.url).toBe(`/api/orgs/${orgId}/provider-connections/openai`);
    });
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("offers the admin-key slot only for Anthropic and OpenAI, riding the main save", async () => {
    const orgId = nextOrgId();
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, body: init?.body });
      if (method === "PUT") {
        // The backend refuses an inference key in the admin slot by prefix,
        // naming both key types (parseSpendSecret's exact behavior).
        return jsonResponse(
          {
            error:
              "That looks like an Anthropic inference key (sk-ant-api…), but the admin slot needs an ADMIN key (sk-ant-admin…) — the two key types are disjoint."
          },
          false,
          400
        );
      }
      return jsonResponse({
        connections: [
          summary({ provider: "anthropic", connected: true, status: "valid" }),
          summary({ provider: "gemini", connected: true, status: "valid" })
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProviderKeysSection canManage orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Anthropic" }));
    const slot = screen.getByLabelText("Anthropic admin key (optional)");
    fireEvent.change(screen.getByLabelText("Anthropic API key"), {
      target: { value: "sk-ant-api03-main" }
    });
    fireEvent.change(slot, { target: { value: "sk-ant-api03-not-an-admin-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));

    expect(await screen.findByText(/the two key types are disjoint/)).toBeInTheDocument();
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe(`/api/orgs/${orgId}/provider-connections/anthropic`);
    expect(JSON.parse(put?.body ?? "{}")).toMatchObject({
      secret: "sk-ant-api03-main",
      spendSecret: "sk-ant-api03-not-an-admin-key"
    });

    fireEvent.click(screen.getByRole("button", { name: "Google Gemini" }));
    expect(screen.queryByLabelText("Google Gemini admin key (optional)")).not.toBeInTheDocument();
  });

  it("shows the admin-key hookup and surfaces the stored admin key's own problem", async () => {
    stubFetch([
      summary({
        provider: "openai",
        connected: true,
        credential_last4: "44ff",
        spend_credential_last4: "9x8y",
        status: "valid",
        status_detail: {
          spend_key: {
            status: "invalid",
            remediation: "OpenAI rejected the admin key. Create one with scope api.usage.read."
          }
        }
      })
    ]);
    render(<ProviderKeysSection canManage={false} orgId={nextOrgId()} />);

    // "Hooked up and how" names both credentials.
    expect(await screen.findByText("API key + admin key (spend)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
    // The admin key's verdict never touches the row's status — the key stays
    // Verified while the admin problem is named beside it.
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(
      screen.getByText(/OpenAI rejected the admin key\. Create one with scope api\.usage\.read\./)
    ).toBeInTheDocument();
  });

  it("refreshes spend on demand and relays the backend's honest verdict", async () => {
    const orgId = nextOrgId();
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method });
      if (method === "POST") {
        return jsonResponse({
          provider: "bedrock",
          kind: "reported",
          refreshed: false,
          staleness_floor_seconds: 10800,
          next_refresh_at: "2026-08-20T12:00:00Z",
          message: "Served from the stored snapshot — Cost Explorer is re-read every 3 hours.",
          snapshot: null
        });
      }
      return jsonResponse({
        connections: [summary({ provider: "bedrock", connected: true, status: "valid" })]
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProviderKeysSection canManage orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Amazon Bedrock" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh spend" }));

    expect(
      await screen.findByText("Served from the stored snapshot — Cost Explorer is re-read every 3 hours.")
    ).toBeInTheDocument();
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe(`/api/orgs/${orgId}/provider-connections/bedrock/spend-refresh`);
  });

  it("renders the full table structure signed out without firing a single fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ProviderKeysSection canManage={false} orgId={null} />, false);

    for (const label of [
      "OpenAI",
      "Anthropic",
      "Google Gemini",
      "Azure Foundry",
      "OpenRouter",
      "Amazon Bedrock",
      "Fireworks AI",
      "Modal"
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // Acting signed-out prompts login in place (the workspace login modal),
    // never a fetch.
    fireEvent.click(screen.getByRole("button", { name: "Expand OpenAI details" }));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-x" } });
    fireEvent.submit(screen.getByLabelText("OpenAI API key").closest("form") as HTMLFormElement);
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays the hookup check's non-valid verdict from the save round-trip", async () => {
    const orgId = nextOrgId();
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
      if ((init?.method ?? "GET") === "PUT") {
        return jsonResponse({
          connection: {},
          check: {
            provider: "openai",
            status: "invalid",
            status_detail: {
              remediation: "OpenAI rejected this key. Create a fresh secret key and paste it whole."
            },
            status_checked_at: "2026-08-18T10:00:00Z",
            status_source: "hookup_check"
          }
        });
      }
      return jsonResponse({ connections: [summary({ provider: "openai" })] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProviderKeysSection canManage orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: "Expand OpenAI details" }));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText(
        "OpenAI rejected this key. Create a fresh secret key and paste it whole."
      )
    ).toBeInTheDocument();
  });
});
