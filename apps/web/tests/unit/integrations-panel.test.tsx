import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

import { IntegrationsPanel, type ConnectionState } from "@/components/settings/IntegrationsPanel";
import {
  ModelProvidersPanel,
  type ProviderConnectionState
} from "@/components/settings/ModelProvidersPanel";

function connection(overrides: Partial<ConnectionState> & { kind: string }): ConnectionState {
  return {
    connected: false,
    credentialLast4: null,
    host: null,
    updatedAt: null,
    broadcastEnabled: false,
    broadcastPrivacyMode: false,
    broadcastCaptureToken: null,
    ...overrides
  };
}

function providerConnection(
  overrides: Partial<ProviderConnectionState> & { provider: ProviderConnectionState["provider"] }
): ProviderConnectionState {
  return {
    connected: false,
    credentialLast4: null,
    config: null,
    updatedAt: null,
    status: "unchecked",
    statusDetail: null,
    statusCheckedAt: null,
    spendCredentialLast4: null,
    declaredBalanceUsd: null,
    declaredBalanceSetAt: null,
    meteredSpendUsd: 0,
    lowBalanceThresholdUsd: 5,
    latestSnapshot: null,
    ...overrides
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("IntegrationsPanel", () => {
  const connections = [
    connection({ kind: "phoenix" }),
    connection({
      kind: "postgres",
      connected: true,
      credentialLast4: "5432",
      updatedAt: "2026-07-30T00:00:00Z"
    })
  ];
  // Public origin each trace source's transfer prompt embeds.
  const BASE = { webBaseUrl: "https://web.test" };

  it("renders closed tiles: no credential form until a tile opens its modal", () => {
    render(<IntegrationsPanel {...BASE} canManage connections={connections} orgId="org-1" />);

    // Trace sources open the SAME connect modal the model providers use
    // (credits/settings redesign 2026-08-22), so nothing renders inline.
    expect(screen.queryByLabelText("Arize Phoenix API key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("integration-arize-phoenix"));
    expect(screen.getByTestId("trace-connect-modal-phoenix")).toBeInTheDocument();
    expect(screen.getByLabelText("Arize Phoenix API key")).toBeInTheDocument();
  });

  it("summarizes a connected tile without opening it", () => {
    render(<IntegrationsPanel {...BASE} canManage connections={connections} orgId="org-1" />);

    expect(
      screen.getByText(`Key ····5432 · updated ${new Date("2026-07-30T00:00:00Z").toLocaleDateString()}`)
    ).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("gives every trace source its own copyable transfer prompt in the modal", () => {
    render(<IntegrationsPanel {...BASE} canManage connections={connections} orgId="org-1" />);

    fireEvent.click(screen.getByTestId("integration-postgres-database"));
    expect(screen.getByTestId("trace-transfer-prompt-postgres")).toBeInTheDocument();
    // The prompt block expands to the source-specific text.
    fireEvent.click(screen.getByText("Connect from your coding agent"));
    expect(screen.getByText(/DATABASE_URL/)).toBeInTheDocument();
    // Escape closes the modal, like every connect modal.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("trace-connect-modal-postgres")).not.toBeInTheDocument();
  });

  it("shows the admin-only note (and no prompt) instead of a form to members", () => {
    render(
      <IntegrationsPanel {...BASE} canManage={false} connections={connections} orgId="org-1" />
    );

    fireEvent.click(screen.getByTestId("integration-arize-phoenix"));
    expect(screen.getByText("Only organization admins can connect.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Arize Phoenix API key")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trace-transfer-prompt-phoenix")).not.toBeInTheDocument();
  });

  it("offers Broadcast only on connected destinations that support it", () => {
    render(
      <IntegrationsPanel
        {...BASE}
        canManage
        connections={[
          connection({ kind: "braintrust", connected: true, credentialLast4: "bt99" }),
          // postgres is a trace SOURCE, never a broadcast destination.
          connection({ kind: "postgres", connected: true, credentialLast4: "5432" })
        ]}
        orgId="org-1"
      />
    );

    fireEvent.click(screen.getByTestId("integration-braintrust"));
    expect(screen.getByText("Broadcast")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    // Postgres is a trace source, never a destination: its modal has no
    // Broadcast block.
    fireEvent.click(screen.getByTestId("integration-postgres-database"));
    expect(screen.queryByText("Broadcast")).not.toBeInTheDocument();
  });

  it("hides Broadcast until the destination is connected", () => {
    render(
      <IntegrationsPanel
        {...BASE}
        canManage
        connections={[connection({ kind: "braintrust" })]}
        orgId="org-1"
      />
    );

    fireEvent.click(screen.getByTestId("integration-braintrust"));
    expect(screen.queryByText("Broadcast")).not.toBeInTheDocument();
  });

  it("sends PostHog's capture token with the broadcast opt-in", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <IntegrationsPanel
          {...BASE}
          canManage
          connections={[connection({ kind: "posthog", connected: true })]}
          orgId="org-1"
        />
      );

      fireEvent.click(screen.getByTestId("integration-posthog"));
      fireEvent.change(screen.getByLabelText("PostHog project API key for broadcast"), {
        target: { value: "phc_public" }
      });
      fireEvent.click(screen.getByLabelText(/Send captured prompts here/));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        broadcast: { enabled: true, privacy_mode: false, capture_token: "phc_public" }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("PATCHes the explicit broadcast opt-in with both settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <IntegrationsPanel
          {...BASE}
          canManage
          connections={[
            connection({ kind: "braintrust", connected: true, broadcastPrivacyMode: true })
          ]}
          orgId="org-1"
        />
      );

      fireEvent.click(screen.getByTestId("integration-braintrust"));
      fireEvent.click(screen.getByLabelText(/Send captured prompts here/));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/orgs/org-1/connections/braintrust");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(String(init.body))).toEqual({
        broadcast: { enabled: true, privacy_mode: true }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ModelProvidersPanel", () => {
  // Public origins the connect modal embeds in each provider's transfer prompt.
  const BASE = { apiBaseUrl: "https://api.test", webBaseUrl: "https://web.test" };

  it("carries the tracked balance drawdown onto the provider tile", () => {
    render(
      <ModelProvidersPanel
        {...BASE}
        canManage={false}
        connections={[
          providerConnection({
            provider: "anthropic",
            connected: true,
            credentialLast4: "ak42",
            declaredBalanceUsd: 100,
            meteredSpendUsd: 12.5
          })
        ]}
        orgId="org-1"
      />
    );

    expect(screen.getByText(/Key ····ak42/)).toBeInTheDocument();
    expect(screen.getByText(/\$87\.50 left/)).toBeInTheDocument();
  });

  it("surfaces the balance state at a glance when no drawdown is tracked", () => {
    render(
      <ModelProvidersPanel
        {...BASE}
        canManage={false}
        connections={[
          // Connected with a provider-reported credits reading (OpenRouter).
          providerConnection({
            provider: "openrouter",
            connected: true,
            credentialLast4: "or01",
            latestSnapshot: {
              taken_at: "2026-08-21T00:00:00Z",
              source: "provider_api",
              spend_usd: 5,
              credits_remaining_usd: 82.29,
              usage_limit_usd: 100,
              detail: null
            }
          }),
          // Connected with neither a declared balance nor a provider reading.
          providerConnection({
            provider: "azure_openai",
            connected: true,
            credentialLast4: "az02"
          })
        ]}
        orgId="org-1"
      />
    );

    expect(screen.getByText(/\$82\.29 credits/)).toBeInTheDocument();
    expect(screen.getByText(/balance not tracked/)).toBeInTheDocument();
  });

  it("opens a modal with the Azure form and its deployment rows on click", () => {
    render(
      <ModelProvidersPanel
        {...BASE}
        canManage
        connections={[providerConnection({ provider: "azure_openai" })]}
        orgId="org-1"
      />
    );

    // No inline form until the modal opens (the product owner, 2026-08-21: connect is a modal).
    expect(screen.queryByLabelText("Azure Foundry resource endpoint")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("provider-tile-azure_openai"));
    expect(screen.getByTestId("provider-connect-modal-azure_openai")).toBeInTheDocument();
    expect(screen.getByLabelText("Azure Foundry resource endpoint")).toBeInTheDocument();
    expect(screen.getByText("Add deployment")).toBeInTheDocument();
  });

  it("shows the per-provider transfer prompt to managers, hides it from members", () => {
    const { rerender } = render(
      <ModelProvidersPanel
        {...BASE}
        canManage
        connections={[providerConnection({ provider: "bedrock" })]}
        orgId="org-1"
      />
    );
    fireEvent.click(screen.getByTestId("provider-tile-bedrock"));
    expect(screen.getByTestId("provider-transfer-prompt-bedrock")).toBeInTheDocument();
    // Escape closes the modal.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("provider-connect-modal-bedrock")).not.toBeInTheDocument();

    // A read-only member gets the balance view but no connect prompt.
    rerender(
      <ModelProvidersPanel
        {...BASE}
        canManage={false}
        connections={[providerConnection({ provider: "bedrock" })]}
        orgId="org-1"
      />
    );
    fireEvent.click(screen.getByTestId("provider-tile-bedrock"));
    expect(screen.queryByTestId("provider-transfer-prompt-bedrock")).not.toBeInTheDocument();
  });
});
