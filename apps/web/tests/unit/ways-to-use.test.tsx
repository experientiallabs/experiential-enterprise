import { fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/models/way-model",
  useRouter: () => ({ push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { WaysToUse } from "@/components/models-catalog/detail/ways-to-use";
import type {
  CatalogDeployment,
  CatalogModel,
  ModelDetail,
  Waterfall
} from "@/lib/models-catalog/types";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";
import { makeDeployment, makeModel } from "./models-catalog-fixtures";

// WaysToUse gates its add-a-way actions through useLoginModal; mount the
// login-modal host (signed in, matching these canManage renders).
function render(ui: Parameters<typeof renderBare>[0]) {
  return renderBare(<LoginModalProvider isAuthenticated>{ui}</LoginModalProvider>);
}

// Module-scoped store cache: each test uses a fresh org + slug for a cold cache.
let seed = 0;
function nextIds(): { orgId: string; slug: string } {
  seed += 1;
  return {
    orgId: `00000000-0000-0000-0000-0000000000e${String(seed).padStart(2, "0")}`,
    slug: `way-model-${seed}`
  };
}

function deployment(id: string, provider: CatalogDeployment["provider"]): CatalogDeployment {
  // Hosted lanes: always usable, so structural tests (toggles, ordering,
  // add-a-way) are independent of the org's connected keys. BYOK gating has
  // its own dedicated tests below.
  return makeDeployment({
    id,
    model_id: "model-uuid",
    provider,
    provider_model_id: "gpt-5.5",
    billing_source: "host_managed",
    status: "active",
    owning_org_id: null
  });
}

function makeConnection(
  provider: ProviderConnectionSummary["provider"],
  connected = true,
  overrides: Partial<ProviderConnectionSummary> = {}
): ProviderConnectionSummary {
  return {
    ...{
    provider,
    connected,
    config: null,
    credential_last4: connected ? "1234" : null,
    spend_credential_last4: null,
    updated_at: connected ? "2026-08-01T00:00:00Z" : null,
    status: connected ? "valid" : "unchecked",
    status_detail: null,
    status_checked_at: null,
    status_source: null,
    declared_balance_usd: null,
    declared_balance_set_at: null,
    metered_spend_usd: 0,
    low_balance_threshold_usd: 0,
    latest_snapshot: null
    } satisfies ProviderConnectionSummary,
    ...overrides
  };
}

function detailPayload(
  slug: string,
  deployments: CatalogDeployment[],
  modelOverride: Partial<CatalogModel> = {}
): ModelDetail {
  return {
    model: makeModel({ id: "model-uuid", slug, display_name: slug, ...modelOverride }),
    providers: deployments,
    default_waterfall: deployments.map((dep, index) => ({
      id: `rung-${dep.id}`,
      position: index,
      model_provider_id: dep.id,
      provider: dep.provider,
      provider_model_id: dep.provider_model_id,
      base_url: dep.base_url,
      status: dep.status
    })),
    huggingface_url: null,
    release_url: null,
    benchmarks: []
  };
}

function waterfallPayload(slug: string, orgId: string, detail: ModelDetail): Waterfall {
  return {
    model_id: "model-uuid",
    slug,
    org_id: orgId,
    default: detail.default_waterfall,
    override: null
  };
}

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function stubFetch(
  slug: string,
  orgId: string,
  deployments: CatalogDeployment[],
  modelOverride: Partial<CatalogModel> = {},
  connections: ProviderConnectionSummary[] = []
) {
  const detail = detailPayload(slug, deployments, modelOverride);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/provider-connections")) {
        return jsonResponse({ connections });
      }
      if (url.includes("/waterfall")) {
        return jsonResponse(waterfallPayload(slug, orgId, detail));
      }
      if (url.includes(`/api/models/${slug}`)) {
        return jsonResponse(detail);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("WaysToUse add-a-way chooser", () => {
  it("offers a choice instead of auto-jumping to the key form", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [deployment("dep-openai", "openai")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add a way/ }));

    // A chooser appears with two clear options; the key form has NOT auto-opened.
    expect(screen.getByTestId("add-a-way-chooser")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add an API key/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add a local model/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI API key")).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-variant-form")).not.toBeInTheDocument();
  });

  it("opens the provider-aware key form on the key path and returns via Back", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [deployment("dep-openai", "openai"), deployment("dep-azure", "azure_openai")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add a way/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add an API key/ }));

    // The embedded key card lists the model's connectable providers.
    const addKeyButtons = await screen.findAllByRole("button", { name: "Add key" });
    expect(addKeyButtons.length).toBeGreaterThan(0);
    fireEvent.click(addKeyButtons[0]);
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();

    // Back returns to the chooser.
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByTestId("add-a-way-chooser")).toBeInTheDocument();
  });

  it("connecting a provider opens the SAME shared modal /credits uses", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [deployment("dep-openai", "openai")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add a way/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add an API key/ }));

    // No inline form; clicking "Add key" opens the shared ProviderConnectModal
    // with its per-provider transfer prompt, logo, and the schema-driven form —
    // identical to the connect experience on /credits and Settings.
    expect(screen.queryByTestId("provider-connect-modal-openai")).not.toBeInTheDocument();
    fireEvent.click((await screen.findAllByRole("button", { name: "Add key" }))[0]);
    expect(screen.getByTestId("provider-connect-modal-openai")).toBeInTheDocument();
    expect(screen.getByTestId("provider-transfer-prompt-openai")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();

    // The modal's own close control dismisses it.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("provider-connect-modal-openai")).not.toBeInTheDocument();
  });

  it("opens the local variant form directly on the local path", async () => {
    const { orgId, slug } = nextIds();
    // An open-weights family, so the local path is offered (see gating tests below).
    stubFetch(slug, orgId, [deployment("dep-openai", "openai")], { icon: "qwen" });
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add a way/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add a local model/ }));

    // defaultOpen: the local form fields are shown straight away, no extra click.
    await waitFor(() => expect(screen.getByTestId("local-variant-form")).toBeInTheDocument());
    expect(screen.getByLabelText(/Base URL/)).toBeInTheDocument();
  });

  it("hides the local-variant option for a proprietary, API-only model", async () => {
    const { orgId, slug } = nextIds();
    // Claude is proprietary: its weights are not published, so it can only be
    // reached through a key, never pointed at a self-hosted endpoint.
    stubFetch(slug, orgId, [deployment("dep-anthropic", "anthropic")], {
      icon: "anthropic",
      display_name: "Claude Sonnet 5"
    });
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add a way/ }));

    // The chooser still appears, but with the key path only.
    expect(screen.getByTestId("add-a-way-chooser")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add an API key/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add a local model/ })).not.toBeInTheDocument();
  });

  it("offers the local-variant option for an open-weights model", async () => {
    const { orgId, slug } = nextIds();
    // Qwen ships open weights, so it can be self-hosted: both paths are offered.
    stubFetch(slug, orgId, [deployment("dep-qwen", "openai")], {
      icon: "qwen",
      display_name: "Qwen3 Max"
    });
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add a way/ }));

    expect(screen.getByRole("button", { name: /Add an API key/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add a local model/ })).toBeInTheDocument();
  });
});

/**
 * One fake backend for the public model reads plus the org-owned local-model
 * create. int-p3's serving shape is an ORG-OWNED model (POST /api/models), not
 * a deployment on the public model — so the create hits /api/models and the
 * public model's waterfall is never touched. Captures the POST body so the test
 * asserts the org-owned shape (namespaced slug + supports_streaming).
 */
function stubLocalBackend(slug: string, orgId: string, initial: CatalogDeployment[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const detail = (): ModelDetail => ({
    model: makeModel({ id: "model-uuid", slug, display_name: slug, icon: "qwen" }),
    providers: initial,
    default_waterfall: initial.map((dep, index) => ({
      id: `rung-${dep.id}`,
      position: index,
      model_provider_id: dep.id,
      provider: dep.provider,
      provider_model_id: dep.provider_model_id,
      base_url: dep.base_url,
      status: dep.status
    })),
    huggingface_url: null,
    release_url: null,
    benchmarks: []
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? null : JSON.parse(init.body);
      calls.push({ url, method, body });
      if (url.includes("/provider-connections")) {
        return jsonResponse({ connections: [] });
      }
      // Org-owned local model create (int-p3 shape): returns the new ModelDetail.
      if (url.endsWith("/api/models") && method === "POST") {
        const created = makeDeployment({
          id: "dep-local-new",
          model_id: "org-model-uuid",
          provider: body.providers[0].provider,
          provider_model_id: body.providers[0].provider_model_id,
          base_url: body.providers[0].base_url,
          owning_org_id: body.org_id
        });
        return jsonResponse({
          model: makeModel({
            id: "org-model-uuid",
            slug: body.slug,
            display_name: body.display_name,
            owning_org_id: body.org_id
          }),
          providers: [created],
          default_waterfall: [
            {
              id: `rung-${created.id}`,
              position: 0,
              model_provider_id: created.id,
              provider: created.provider,
              provider_model_id: created.provider_model_id,
              base_url: created.base_url,
              status: created.status
            }
          ],
          huggingface_url: null,
          release_url: null,
          benchmarks: []
        } satisfies ModelDetail);
      }
      if (url.includes("/waterfall")) {
        return jsonResponse(waterfallPayload(slug, orgId, detail()));
      }
      if (url.includes(`/api/models/${slug}`)) {
        return jsonResponse(detail());
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    })
  );
  return { calls };
}

describe("WaysToUse local model", () => {
  it("creates an ORG-OWNED model (int-p3 shape) with supports_streaming, not a public deployment", async () => {
    const { orgId, slug } = nextIds();
    const { calls } = stubLocalBackend(slug, orgId, [deployment("dep-openai", "openai")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add a way/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add a local model/ }));
    fireEvent.change(await screen.findByLabelText(/Base URL/), {
      target: { value: "https://vllm.internal:8000/v1" }
    });
    fireEvent.change(screen.getByLabelText(/Served model id/), {
      target: { value: "qwen3-max" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Create local model/ }));

    // The create is an org-owned model POST /api/models, org-namespaced slug,
    // with a local provider row declaring supports_streaming (int-p3 MUST).
    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/api/models"));
      expect(post).toBeTruthy();
      const posted = post!.body as {
        org_id: string;
        slug: string;
        providers: { provider: string; base_url: string; provider_model_id: string; capabilities: Record<string, boolean> }[];
      };
      expect(posted.org_id).toBe(orgId);
      expect(posted.slug).toContain("-local-");
      expect(posted.slug).toMatch(/^[a-z]/);
      expect(posted.providers[0]).toMatchObject({
        provider: "local",
        base_url: "https://vllm.internal:8000/v1",
        provider_model_id: "qwen3-max"
      });
      expect(posted.providers[0].capabilities.supports_streaming).toBe(true);
    });

    // It never touches the PUBLIC model's waterfall (that shape wouldn't route).
    expect(
      calls.some((call) => call.method === "PUT" && call.url.includes("/waterfall"))
    ).toBe(false);

    // Success surfaces the created org model + a link to it.
    expect(await screen.findByText(/private to your organization/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View model/ })).toBeInTheDocument();
  });
});

/**
 * A waterfall-mutating backend: PUT /waterfall stores the posted id list as the
 * override (empty clears it) and every read reflects it, so toggling a provider
 * off/on round-trips through the one org-scoped mechanism the product uses.
 */
function stubToggleBackend(
  slug: string,
  orgId: string,
  deployments: CatalogDeployment[],
  connections: ProviderConnectionSummary[] = [],
  initialOverride: string[] | null = null
) {
  const detail = detailPayload(slug, deployments);
  let override: Waterfall["override"] = null;
  if (initialOverride !== null) {
    override = initialOverride.map((id, index) => rungForInit(id, index));
  }
  function rungForInit(id: string, position: number) {
    const dep = deployments.find((d) => d.id === id)!;
    return {
      id: `rung-${id}`,
      position,
      model_provider_id: id,
      provider: dep.provider,
      provider_model_id: dep.provider_model_id,
      base_url: dep.base_url,
      status: dep.status
    };
  }
  const rungFor = (id: string, position: number) => {
    const dep = deployments.find((d) => d.id === id)!;
    return {
      id: `rung-${id}`,
      position,
      model_provider_id: id,
      provider: dep.provider,
      provider_model_id: dep.provider_model_id,
      base_url: dep.base_url,
      status: dep.status
    };
  };
  const waterfall = (): Waterfall => ({
    model_id: "model-uuid",
    slug,
    org_id: orgId,
    default: detail.default_waterfall,
    override
  });
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? null : JSON.parse(init.body);
      calls.push({ url, method, body });
      if (url.includes("/provider-connections")) {
        return jsonResponse({ connections });
      }
      if (url.includes("/waterfall") && method === "PUT") {
        const ids = body.model_provider_ids as string[];
        override = ids.length === 0 ? null : ids.map((id, index) => rungFor(id, index));
        return jsonResponse(waterfall());
      }
      if (url.includes("/waterfall")) {
        return jsonResponse(waterfall());
      }
      if (url.includes(`/api/models/${slug}`)) {
        return jsonResponse(detail);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    })
  );
  return { calls };
}

describe("WaysToUse serving truth", () => {
  it("labels an active public host-managed route as Through Experiential", async () => {
    const { orgId, slug } = nextIds();
    const hosted = makeDeployment({
      id: "dep-hosted",
      model_id: "model-uuid",
      provider: "openrouter",
      provider_model_id: "z-ai/glm-5.3",
      billing_source: "host_managed",
      status: "active",
      owning_org_id: null
    });
    stubFetch(slug, orgId, [hosted]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.getByText("Through Experiential")).toBeInTheDocument();
    expect(screen.getByText("uses credits")).toBeInTheDocument();
  });

  it("labels a PUBLIC customer-managed (BYOK) route as your key, not Experiential", async () => {
    const { orgId, slug } = nextIds();
    // The bug: a public row (owning_org_id null) that is BYOK used to read
    // "Through Experiential — uses credits". It must read as a your-key route.
    // The org has the fireworks key connected, so the lane is usable and shown.
    const byok = makeDeployment({
      id: "dep-byok",
      model_id: "model-uuid",
      provider: "fireworks",
      provider_model_id: "accounts/fireworks/models/inkling-small",
      billing_source: "customer_managed",
      status: "active",
      owning_org_id: null
    });
    stubFetch(slug, orgId, [byok], {}, [makeConnection("fireworks")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.queryByText("Through Experiential")).not.toBeInTheDocument();
    expect(screen.getAllByText(/your key|connected/).length).toBeGreaterThan(0);
  });
});

describe("WaysToUse waterfall gating", () => {
  const hosted = () =>
    makeDeployment({
      id: "dep-hosted",
      model_id: "model-uuid",
      provider: "openrouter",
      provider_model_id: "z-ai/glm-5.3",
      billing_source: "host_managed",
      status: "active",
      owning_org_id: null
    });
  const byok = () =>
    makeDeployment({
      id: "dep-fireworks",
      model_id: "model-uuid",
      provider: "fireworks",
      provider_model_id: "accounts/fireworks/models/kimi-k2p6",
      billing_source: "customer_managed",
      status: "active",
      owning_org_id: null
    });

  it("with no keys connected, only Experiential-hosted lanes appear", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [hosted(), byok()]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.getByText("Through Experiential")).toBeInTheDocument();
    // The unusable Fireworks your-key lane is NOT listed in the waterfall;
    // availability discovery lives in the providers table instead.
    expect(screen.queryByText(/kimi-k2p6/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("connecting the provider's key makes its lane appear", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [hosted(), byok()], {}, [makeConnection("fireworks")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.getByText("Through Experiential")).toBeInTheDocument();
    expect(screen.getByText(/kimi-k2p6/)).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
  });

  it("a BYOK-only model with no keys shows the connect-a-key empty state", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [byok()]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    expect(await screen.findByText(/No usable route yet/)).toBeInTheDocument();
  });

  it("renders the Waterfall heading with the info tooltip, not the old copy", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [hosted()]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.getByText("Waterfall")).toBeInTheDocument();
    expect(screen.getByLabelText("About the waterfall")).toHaveAttribute(
      "title",
      expect.stringContaining("Drag to reorder")
    );
    expect(screen.queryByText("Ways to use this model")).not.toBeInTheDocument();
  });

  it("a connected but INVALID or quota-exhausted key does not make a lane usable", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [hosted(), byok()], {}, [
      makeConnection("fireworks", true, { status: "invalid" })
    ]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.queryByText(/kimi-k2p6/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("a connected Azure key with NO deployment verdict stays unusable (fail closed)", async () => {
    const { orgId, slug } = nextIds();
    const azure = makeDeployment({
      id: "dep-azure-unknown",
      model_id: "model-uuid",
      provider: "azure_openai",
      provider_model_id: "FW-Kimi-K2.6",
      billing_source: "customer_managed",
      status: "active",
      owning_org_id: null
    });
    // Connected, but status_detail carries no verdict for this model: the
    // waterfall lists only routes KNOWN to serve, so unverified stays out.
    stubFetch(slug, orgId, [hosted(), azure], {}, [makeConnection("azure_openai")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.queryByText(/FW-Kimi-K2.6/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("a connected Azure key without this model's deployment stays unusable", async () => {
    const { orgId, slug } = nextIds();
    const azure = makeDeployment({
      id: "dep-azure",
      model_id: "model-uuid",
      provider: "azure_openai",
      provider_model_id: "FW-Kimi-K2.6",
      billing_source: "customer_managed",
      status: "active",
      owning_org_id: null
    });
    stubFetch(slug, orgId, [hosted(), azure], {}, [
      makeConnection("azure_openai", true, {
        status_detail: { models: { [slug]: { deployment: "FW-Kimi-K2.6", deployed: false } } }
      })
    ]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.queryByText(/FW-Kimi-K2.6/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });
});

describe("WaysToUse provider toggle", () => {
  it("labels the two price numbers with per-million input/output units", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [deployment("dep-openai", "openai")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.getAllByText(/\/M in/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\/M out/).length).toBeGreaterThan(0);
  });

  it("shows a per-route Use switch, not an eye/hide control", async () => {
    const { orgId, slug } = nextIds();
    stubFetch(slug, orgId, [deployment("dep-openai", "openai")]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    // The framing is a clean on/off toggle, never "hide".
    expect(screen.queryByRole("button", { name: /^Hide / })).toBeNull();
    expect(screen.queryByTestId("ways-to-use-hidden")).toBeNull();
    // The only route's switch is on and locked (a model must keep one route).
    const only = screen.getByRole("switch");
    expect(only).toHaveAttribute("aria-checked", "true");
    expect(only).toBeDisabled();
  });

  it("turns a route off and back on through the waterfall override, staying stable", async () => {
    const { orgId, slug } = nextIds();
    const { calls } = stubToggleBackend(slug, orgId, [
      deployment("dep-openai", "openai"),
      deployment("dep-bedrock", "bedrock")
    ]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    // Both routes on: two switches, both checked, neither locked.
    const switches = await screen.findAllByRole("switch");
    expect(switches).toHaveLength(2);
    switches.forEach((toggle) => expect(toggle).toHaveAttribute("aria-checked", "true"));

    // Turn the second route off: it persists a one-provider override.
    fireEvent.click(screen.getByRole("switch", { name: /Turn Bedrock off/ }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT" && call.url.includes("/waterfall"));
      expect((put!.body as { model_provider_ids: string[] }).model_provider_ids).toEqual([
        "dep-openai"
      ]);
    });

    // The row stays in place, now off — and STAYS off after the server re-read
    // settles (the optimistic draft reconciles instead of flickering back on).
    const bedrockOff = await screen.findByRole("switch", { name: /Turn Bedrock on/ });
    expect(bedrockOff).toHaveAttribute("aria-checked", "false");
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /Turn Bedrock on/ })).toHaveAttribute(
        "aria-checked",
        "false"
      )
    );
    expect(screen.queryByTestId("ways-to-use-hidden")).toBeNull();

    // Turn it back on: the override clears and both switches read on again.
    fireEvent.click(screen.getByRole("switch", { name: /Turn Bedrock on/ }));
    await waitFor(() =>
      expect(screen.getAllByRole("switch")).toHaveLength(2)
    );
    await waitFor(() =>
      screen.getAllByRole("switch").forEach((toggle) =>
        expect(toggle).toHaveAttribute("aria-checked", "true")
      )
    );
  });
});

describe("WaysToUse hidden-lane persistence", () => {
  it("a hidden lane at the FRONT of the chain keeps its position on save", async () => {
    const { orgId, slug } = nextIds();
    const hidden = makeDeployment({
      id: "dep-hidden-first",
      model_id: "model-uuid",
      provider: "fireworks",
      provider_model_id: "accounts/fireworks/models/kimi-k2p6",
      billing_source: "customer_managed",
      status: "active",
      owning_org_id: null
    });
    // The org's OVERRIDE puts the (now hidden) BYOK lane FIRST. Toggling
    // bedrock off must persist [hidden, openai] — the hidden lane keeps its
    // configured slot instead of being demoted to the end. (The default chain
    // has no user positions; it band-sorts hosted-first by design.)
    const { calls } = stubToggleBackend(
      slug,
      orgId,
      [hidden, deployment("dep-openai", "openai"), deployment("dep-bedrock", "bedrock")],
      [],
      ["dep-hidden-first", "dep-openai", "dep-bedrock"]
    );
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    fireEvent.click(screen.getByRole("switch", { name: /Turn Bedrock off/ }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT" && call.url.includes("/waterfall"));
      expect(put).toBeTruthy();
      expect((put!.body as { model_provider_ids: string[] }).model_provider_ids).toEqual([
        "dep-hidden-first",
        "dep-openai"
      ]);
    });
  });

  it("a save keeps enabled lanes hidden by a missing key in the org chain", async () => {
    const { orgId, slug } = nextIds();
    const hidden = makeDeployment({
      id: "dep-hidden-byok",
      model_id: "model-uuid",
      provider: "fireworks",
      provider_model_id: "accounts/fireworks/models/kimi-k2p6",
      billing_source: "customer_managed",
      status: "active",
      owning_org_id: null
    });
    // Two hosted lanes plus a BYOK lane that sits in the default chain but is
    // hidden right now (no fireworks key). Toggling a hosted lane off must
    // persist [remaining hosted, hidden BYOK], never drop the hidden lane.
    const { calls } = stubToggleBackend(slug, orgId, [
      deployment("dep-openai", "openai"),
      deployment("dep-bedrock", "bedrock"),
      hidden
    ]);
    render(<WaysToUse canManage modelSlug={slug} orgId={orgId} />);

    await screen.findByTestId("ways-to-use-rows");
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    fireEvent.click(screen.getByRole("switch", { name: /Turn Bedrock off/ }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT" && call.url.includes("/waterfall"));
      expect(put).toBeTruthy();
      expect((put!.body as { model_provider_ids: string[] }).model_provider_ids).toEqual([
        "dep-openai",
        "dep-hidden-byok"
      ]);
    });
  });
});
