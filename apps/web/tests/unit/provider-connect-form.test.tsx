import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}));

import { ProviderConnectForm } from "@/components/keys/provider-connect-form";
import type { ModelProvider } from "@/lib/model-providers";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";

let seed = 0;
function orgId(): string {
  seed += 1;
  return `00000000-0000-0000-0000-0000000000${String(seed).padStart(2, "0")}`;
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

type PutCall = { url: string; body: Record<string, unknown> };

function stubFetch(): { puts: PutCall[] } {
  const puts: PutCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "PUT") {
      puts.push({ url, body: init?.body === undefined ? {} : JSON.parse(init.body) });
    }
    const payload = { check: { provider: "x", status: "valid", status_detail: null } };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { puts };
}

// Mutations run inline: the form's `gate` is the login/requireAuth wrapper.
const gate = (fn: () => void) => fn();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ProviderConnectForm provider-aware fields", () => {
  it("renders only an API key for a plain provider and gates submit on it", async () => {
    const { puts } = stubFetch();
    const org = orgId();
    render(
      <ProviderConnectForm connection={summary({ provider: "openai" })} gate={gate} orgId={org} />
    );

    // The single-field provider: a key, no endpoint or region.
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();
    expect(screen.queryByLabelText("Azure Foundry resource endpoint")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("AWS region")).not.toBeInTheDocument();

    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();

    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-live" } });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toContain(`/provider-connections/openai`);
    expect(puts[0].body).toEqual({ secret: "sk-live", config: {} });
  });

  it("renders Azure's multi-field set and gates submit on key, endpoint, and a deployment", async () => {
    const { puts } = stubFetch();
    const org = orgId();
    render(
      <ProviderConnectForm
        connection={summary({ provider: "azure_openai" })}
        gate={gate}
        orgId={org}
      />
    );

    // Azure is called differently: endpoint, optional api version, deployments.
    expect(screen.getByLabelText("Azure Foundry API key")).toBeInTheDocument();
    expect(screen.getByLabelText("Azure Foundry resource endpoint")).toBeInTheDocument();
    expect(screen.getByLabelText("Azure Foundry API version (optional)")).toBeInTheDocument();

    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();

    // Key alone is not enough for Azure.
    fireEvent.change(screen.getByLabelText("Azure Foundry API key"), { target: { value: "azkey" } });
    expect(connect).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Azure Foundry resource endpoint"), {
      target: { value: "https://res.openai.azure.com" }
    });
    // Endpoint present but still no deployment: blocked.
    expect(connect).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Model 1"), { target: { value: "gpt-5.5" } });
    fireEvent.change(screen.getByLabelText("Deployment 1"), { target: { value: "my-dep" } });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toContain(`/provider-connections/azure_openai`);
    // Endpoint always sent; the optional api_version omitted when empty; the
    // deployment map built from the filled row.
    expect(puts[0].body).toEqual({
      secret: "azkey",
      config: {
        endpoint: "https://res.openai.azure.com",
        deployments: { "gpt-5.5": "my-dep" }
      }
    });
  });

  it("sends the Bedrock triple as secret plus key-id and region config", async () => {
    const { puts } = stubFetch();
    const org = orgId();
    render(
      <ProviderConnectForm connection={summary({ provider: "bedrock" })} gate={gate} orgId={org} />
    );

    const connect = screen.getByRole("button", { name: "Connect" });
    fireEvent.change(screen.getByLabelText("Amazon Bedrock secret access key"), {
      target: { value: "aws-secret" }
    });
    expect(connect).toBeDisabled();
    fireEvent.change(screen.getByLabelText("AWS access key id"), {
      target: { value: "AKIAEXAMPLE12345" }
    });
    fireEvent.change(screen.getByLabelText("AWS region"), { target: { value: "us-east-1" } });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({
      secret: "aws-secret",
      config: { access_key_id: "AKIAEXAMPLE12345", region: "us-east-1" }
    });
  });

  it("sends the Modal token pair as the secret", async () => {
    const { puts } = stubFetch();
    const org = orgId();
    render(
      <ProviderConnectForm connection={summary({ provider: "modal" })} gate={gate} orgId={org} />
    );

    const connect = screen.getByRole("button", { name: "Connect" });
    fireEvent.change(screen.getByLabelText("Modal token id"), { target: { value: "ak-1" } });
    expect(connect).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Modal token secret"), { target: { value: "as-2" } });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({
      secret: { token_id: "ak-1", token_secret: "as-2" },
      config: {}
    });
  });
});
