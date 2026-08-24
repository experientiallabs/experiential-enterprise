import { fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/models/model",
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { UseViaKeyCard } from "@/components/keys/use-via-key-card";
import type { ModelProvider } from "@/lib/model-providers";
import type {
  CatalogDeployment,
  ModelDetail,
  Waterfall,
  WaterfallRung
} from "@/lib/models-catalog/types";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";
import { makeDeployment, makeModel } from "./models-catalog-fixtures";

// The card calls useLoginModal at render, so every test mounts it under the
// provider the workspace layout supplies; `isAuthenticated` drives whether a
// gated action runs or bounces to the login modal.
function render(ui: Parameters<typeof renderBare>[0], isAuthenticated = true) {
  return renderBare(<LoginModalProvider isAuthenticated={isAuthenticated}>{ui}</LoginModalProvider>);
}

// The KeyHub store caches per key at module scope, so every test uses its own
// org and model slug to start from a cold cache.
let seed = 0;
function nextIds(): { orgId: string; slug: string } {
  seed += 1;
  return {
    orgId: `00000000-0000-0000-0000-00000000c0${String(seed).padStart(2, "0")}`,
    slug: `model-${seed}`
  };
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

function deployment(
  id: string,
  provider: CatalogDeployment["provider"],
  providerModelId: string
): CatalogDeployment {
  return makeDeployment({
    id,
    model_id: "model-uuid",
    provider,
    provider_model_id: providerModelId
  });
}

function rung(position: number, dep: CatalogDeployment): WaterfallRung {
  return {
    id: `rung-${dep.id}-${position}`,
    position,
    model_provider_id: dep.id,
    provider: dep.provider,
    provider_model_id: dep.provider_model_id,
    base_url: dep.base_url,
    status: dep.status
  };
}

function detailPayload(slug: string, deployments: CatalogDeployment[]): ModelDetail {
  return {
    model: makeModel({ id: "model-uuid", slug, display_name: slug }),
    providers: deployments,
    default_waterfall: deployments.map((dep, index) => rung(index, dep)),
    huggingface_url: null,
    release_url: null,
    benchmarks: []
  };
}

function waterfallPayload(
  slug: string,
  orgId: string,
  deployments: CatalogDeployment[],
  override: CatalogDeployment[] | null
): Waterfall {
  return {
    model_id: "model-uuid",
    slug,
    org_id: orgId,
    default: deployments.map((dep, index) => rung(index, dep)),
    override: override === null ? null : override.map((dep, index) => rung(index, dep))
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

type FetchCall = { url: string; method: string; body: unknown };

/**
 * One fake backend for the card's reads and writes. Waterfall PUTs mutate the
 * served override, so a refresh (or a remount) reads back what was written —
 * the persistence the spec demands.
 */
function stubFetch(options: {
  slug: string;
  orgId: string;
  deployments: CatalogDeployment[];
  connections?: ProviderConnectionSummary[];
  override?: CatalogDeployment[] | null;
}) {
  const calls: FetchCall[] = [];
  const state = { override: options.override ?? null };
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? null : JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url.includes("/provider-connections/azure_openai/deployment-check")) {
      return jsonResponse({
        provider: "azure_openai",
        model: options.slug,
        deployment: body?.deployment ?? "mapped-deployment",
        deployed: false,
        checked_at: "2026-08-19T00:00:00Z",
        detail: null
      });
    }
    if (url.includes("/provider-connections")) {
      return jsonResponse({ connections: options.connections ?? [] });
    }
    if (url.includes("/waterfall")) {
      if (method === "PUT") {
        const ids = (body?.model_provider_ids ?? []) as string[];
        state.override =
          ids.length === 0
            ? null
            : ids.map((id) => options.deployments.find((dep) => dep.id === id)!);
      }
      return jsonResponse(
        waterfallPayload(options.slug, options.orgId, options.deployments, state.override)
      );
    }
    if (url.includes(`/api/models/${options.slug}`)) {
      return jsonResponse(detailPayload(options.slug, options.deployments));
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const OPENAI = deployment("dep-openai", "openai", "gpt-5.5");
const AZURE = deployment("dep-azure", "azure_openai", "gpt-5.5");
const LOCAL = deployment("dep-local", "local", "gpt-5.5-local");

describe("UseViaKeyCard", () => {
  it("shows a valid connected provider as serving this model via the org key", async () => {
    const { orgId, slug } = nextIds();
    stubFetch({
      slug,
      orgId,
      deployments: [OPENAI, AZURE, LOCAL],
      connections: [
        summary({ provider: "openai", connected: true, status: "valid", credential_last4: "1234" })
      ]
    });
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    expect(await screen.findByTestId("serves-via-key")).toHaveTextContent(
      "Serves this model via your key ····1234"
    );
    // Azure stays an honest separate row: no key there yet.
    expect(screen.getAllByText("Not connected")).toHaveLength(1);
    // `local` deployments are self-hosted endpoints, not keys: no key row
    // (only Azure's unconnected one), though the rung still ranks in the
    // priority list below.
    expect(screen.getAllByRole("button", { name: "Add key" })).toHaveLength(1);
    expect(screen.getByTestId("provider-priority").textContent).toContain("gpt-5.5-local");
  });

  it("renders the canonical Azure message when the model's deployment is missing", async () => {
    const { orgId, slug } = nextIds();
    stubFetch({
      slug,
      orgId,
      deployments: [OPENAI, AZURE],
      connections: [
        summary({
          provider: "azure_openai",
          connected: true,
          status: "valid",
          credential_last4: "9876",
          config: { endpoint: "https://res.openai.azure.com", deployments: { [slug]: "my-dep" } },
          status_detail: {
            remediation: "The Azure OpenAI key works against this resource endpoint.",
            models: {
              [slug]: {
                deployment: "my-dep",
                deployed: false,
                checked_at: "2026-08-19T00:00:00Z",
                remediation:
                  "You have a key, but this model isn't deployed: the resource has no " +
                  "deployment named 'my-dep'."
              }
            }
          }
        })
      ]
    });
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    expect(await screen.findByTestId("azure-not-deployed")).toHaveTextContent(
      "You have a key, but this model isn't deployed."
    );
    // The verbose remediation renders in full, and the fix — the deployment
    // name — is right there.
    expect(
      screen.getByText(/the resource has no deployment named 'my-dep'/)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(`Azure deployment name for ${slug}`)).toHaveValue("my-dep");
  });

  it("maps and probes an unmapped Azure deployment inline in one round-trip", async () => {
    const { orgId, slug } = nextIds();
    const { calls } = stubFetch({
      slug,
      orgId,
      deployments: [OPENAI, AZURE],
      connections: [
        summary({
          provider: "azure_openai",
          connected: true,
          status: "valid",
          credential_last4: "9876",
          config: { endpoint: "https://res.openai.azure.com", deployments: {} }
        })
      ]
    });
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    const input = await screen.findByLabelText(`Azure deployment name for ${slug}`);
    fireEvent.change(input, { target: { value: "my-new-dep" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => {
      const check = calls.find((call) => call.url.includes("/deployment-check"));
      expect(check).toBeDefined();
      expect(check?.method).toBe("POST");
      expect(check?.body).toEqual({ model: slug, deployment: "my-new-dep" });
    });
  });

  it("probes a mapped but never-checked Azure deployment on mount", async () => {
    const { orgId, slug } = nextIds();
    const { calls } = stubFetch({
      slug,
      orgId,
      deployments: [AZURE],
      connections: [
        summary({
          provider: "azure_openai",
          connected: true,
          status: "valid",
          credential_last4: "9876",
          config: { endpoint: "https://res.openai.azure.com", deployments: { [slug]: "my-dep" } }
        })
      ]
    });
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    await waitFor(() => {
      const check = calls.find((call) => call.url.includes("/deployment-check"));
      expect(check?.body).toEqual({ model: slug });
    });
  });

  it("offers the inline add-key flow for an unconnected provider", async () => {
    const { orgId, slug } = nextIds();
    stubFetch({ slug, orgId, deployments: [OPENAI, AZURE], connections: [] });
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    const addButtons = await screen.findAllByRole("button", { name: "Add key" });
    expect(addButtons).toHaveLength(2);
    fireEvent.click(addButtons[0]);
    // The SAME connect flow as settings: the shared form, the shared store.
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();
  });

  it("falls back to the full provider picker when the catalog names none to key", async () => {
    // A model whose only catalog route is a self-hosted endpoint: the old card
    // derived its list from the catalog alone and rendered nothing, so "Add an
    // API key" showed no platform to pick. Now the full BYOK list is offered.
    const { orgId, slug } = nextIds();
    stubFetch({ slug, orgId, deployments: [LOCAL], connections: [] });
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    // Every BYOK provider is a selectable "Add key" row — including ones with no
    // catalog deployment for this model (Anthropic, Amazon Bedrock, Modal …).
    const addButtons = await screen.findAllByRole("button", { name: "Add key" });
    expect(addButtons).toHaveLength(8);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Amazon Bedrock")).toBeInTheDocument();
    expect(screen.getByText("Modal")).toBeInTheDocument();
  });

  it("persists a reorder through the waterfall PUT and reads it back after refresh", async () => {
    const { orgId, slug } = nextIds();
    const { calls, state } = stubFetch({
      slug,
      orgId,
      deployments: [OPENAI, AZURE],
      connections: [
        summary({ provider: "openai", connected: true, status: "valid", credential_last4: "1234" })
      ]
    });
    const first = render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Move OpenAI down" }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put).toBeDefined();
      expect(put?.body).toEqual({ org_id: orgId, model_provider_ids: ["dep-azure", "dep-openai"] });
    });
    // The fake backend now holds the override — the "refresh": a fresh mount
    // reads the persisted order back.
    expect(state.override?.map((dep) => dep.id)).toEqual(["dep-azure", "dep-openai"]);
    first.unmount();
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    const priority = await screen.findByTestId("provider-priority");
    await waitFor(() => {
      const labels = Array.from(priority.querySelectorAll("li")).map((li) => li.textContent);
      expect(labels[0]).toContain("Azure Foundry");
      expect(labels[1]).toContain("OpenAI");
    });
    expect(screen.getByRole("button", { name: "Reset to default order" })).toBeInTheDocument();
  });

  it("clears the override back to the default order", async () => {
    const { orgId, slug } = nextIds();
    const { calls } = stubFetch({
      slug,
      orgId,
      deployments: [OPENAI, AZURE],
      connections: [],
      override: [AZURE, OPENAI]
    });
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reset to default order" }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put?.body).toEqual({ org_id: orgId, model_provider_ids: [] });
    });
  });

  it("renders signed out from the public catalog only and gates every action behind login", async () => {
    const { slug } = nextIds();
    const { calls } = stubFetch({ slug, orgId: "unused", deployments: [OPENAI, AZURE] });
    render(<UseViaKeyCard canManage={false} modelSlug={slug} orgId={null} />, false);
    // The provider structure is visible (the key row and the priority list)…
    expect(await screen.findAllByText("OpenAI")).toHaveLength(2);
    expect(screen.getByTestId("provider-priority")).toBeInTheDocument();
    // …from the public model read alone: no account-scoped fetch fired.
    expect(calls.every((call) => call.url.startsWith(`/api/models/${slug}`))).toBe(true);
    // Acting prompts login in place (the workspace login modal), never a
    // mutating call: reordering…
    fireEvent.click(screen.getByRole("button", { name: "Move OpenAI down" }));
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    // …and submitting the add-key form.
    fireEvent.click(screen.getAllByRole("button", { name: "Add key" })[0]);
    const keyInput = screen.getByLabelText("OpenAI API key");
    fireEvent.change(keyInput, { target: { value: "sk-something" } });
    fireEvent.submit(keyInput.closest("form")!);
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("surfaces a key-level problem with the stored remediation, in full", async () => {
    const { orgId, slug } = nextIds();
    stubFetch({
      slug,
      orgId,
      deployments: [OPENAI, AZURE],
      connections: [
        summary({
          provider: "openai",
          connected: true,
          status: "invalid",
          credential_last4: "1234",
          status_detail: {
            provider_message: "Incorrect API key provided",
            remediation: "OpenAI rejected the key ending ····1234. Paste a current project key."
          }
        })
      ]
    });
    render(<UseViaKeyCard canManage modelSlug={slug} orgId={orgId} />);
    expect(await screen.findByText("Invalid key")).toBeInTheDocument();
    expect(
      screen.getByText(/OpenAI rejected the key ending ····1234\. Paste a current project key\./)
    ).toBeInTheDocument();
  });
});
