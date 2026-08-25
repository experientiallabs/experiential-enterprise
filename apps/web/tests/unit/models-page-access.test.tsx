import { fireEvent, render as renderBare, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /models is the public catalog URL for both audiences, but this build gates
// the catalog DISPLAY behind the provider gate: a viewer whose org has no
// provider connection (and no org-owned model) gets the connect-a-provider
// prompt, and once connected the table shows ONLY callable models (a
// deployment on a connected provider, or the org's own rows). The detail
// route stays public and ungated; its reserved-slug guard must still route
// away.
const redirect = vi.hoisted(() =>
  vi.fn((target: string): never => {
    throw new Error(`redirect:${target}`);
  })
);
const notFound = vi.hoisted(() =>
  vi.fn((): never => {
    throw new Error("not-found");
  })
);
const fetchPublicCatalog = vi.hoisted(() => vi.fn());
const fetchModelDetail = vi.hoisted(() => vi.fn());
const fetchOrgOwnedModels = vi.hoisted(() => vi.fn());
const getAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  notFound,
  redirect,
  usePathname: () => "/models",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/lib/models-catalog/server", () => ({
  fetchModelDetail,
  fetchOrgOwnedModels,
  fetchPublicCatalog
}));
vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient, getAuthenticatedUser }));
// The storefront's provider gate resolves the active org tolerantly; the
// strict resolver must never run (it redirects), so it throws here.
vi.mock("@/lib/active-org", () => ({
  resolveActiveOrg: vi.fn(() => {
    throw new Error("resolveActiveOrg must not run on the storefront");
  }),
  resolveActiveOrgForTelemetry: vi.fn(async () => ({ id: "org-1", slug: "acme", name: "Acme" }))
}));
vi.mock("@/lib/data-source", () => ({
  getDataSource: vi.fn(() => {
    throw new Error("getDataSource must not run signed out");
  })
}));

import ModelPage from "@/app/(workspace)/models/[modelSlug]/page";
import ModelsPage from "@/app/(workspace)/models/page";
import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { makeDetail, makeEntry } from "./models-catalog-fixtures";

// The public catalog renders signed out; the detail page's WaysToUse gates
// through the login modal, so mount the (signed-out) provider host it needs.
function render(ui: Parameters<typeof renderBare>[0]) {
  return renderBare(<LoginModalProvider isAuthenticated={false}>{ui}</LoginModalProvider>);
}

function pageProps(slug: string) {
  return {
    params: Promise.resolve({ modelSlug: slug }),
    searchParams: Promise.resolve({})
  };
}

/** A signed-in member whose org has connected exactly these providers. */
function signInWithConnections(providers: string[]) {
  getAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  createServerSupabaseClient.mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve({ data: providers.map((provider) => ({ provider })), error: null })
      })
    })
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthenticatedUser.mockResolvedValue(null);
  fetchOrgOwnedModels.mockResolvedValue({ models: [], total: 0, limit: 1000, offset: 0 });
});

describe("models index (provider gate)", () => {
  it("shows the connect-a-provider prompt signed out, never the catalog", async () => {
    fetchPublicCatalog.mockResolvedValue({
      models: [makeEntry()],
      total: 1,
      limit: 1000,
      offset: 0
    });

    render(await ModelsPage());

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByText("Connect a provider to see models")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    // Registering an owned model is one of the two ways to open the gate, and
    // the gate hides CatalogTable's toolbar, so the door must survive it.
    expect(screen.getByRole("link", { name: /Add model/ })).toHaveAttribute(
      "href",
      "/models/new"
    );
  });

  it("shows only connected providers' models; org-owned rows always display", async () => {
    signInWithConnections(["openrouter"]);
    fetchPublicCatalog.mockResolvedValue({
      models: [
        makeEntry(
          { id: "m-or", slug: "kimi-k2.6", display_name: "Kimi K2.6", preferred_rank: 1 },
          [{ provider: "openrouter", input_micro_usd_per_million: 541_500 }]
        ),
        // Public model on a provider the org has NOT connected: not callable,
        // so it must not display anywhere (no band, no row).
        makeEntry(
          { id: "m-an", slug: "claude-opus-5", display_name: "Claude Opus 5", preferred_rank: 2 },
          [{ provider: "anthropic" }]
        ),
        // Org-owned row on an unconnected provider: always callable by its org.
        makeEntry(
          {
            id: "m-own",
            slug: "own-local",
            display_name: "Own Local",
            preferred_rank: 3,
            owning_org_id: "org-1"
          },
          [{ provider: "local" }]
        )
      ],
      total: 3,
      limit: 1000,
      offset: 0
    });

    const { container } = render(await ModelsPage());

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    expect(screen.getByText("Own Local")).toBeInTheDocument();
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
    // Both visible models are preferred, so they lead the always-open
    // Recommended band, and each also folds into its own family band (the
    // additive overlay: Kimi from "Kimi K2.6", Own from "Own Local"). The
    // unconnected Claude Opus 5 was filtered out, so it contributes no
    // "Claude" band — the gate, not the overlay, is what removed it.
    const bands = [...container.querySelectorAll("tbody .mono-label")].map(
      (node) => node.textContent
    );
    expect(bands).toEqual(["Recommended", "Kimi", "Own"]);
  });

  it("leads with the recommended band and folds other providers once connected", async () => {
    signInWithConnections(["openrouter"]);
    fetchPublicCatalog.mockResolvedValue({
      models: [
        makeEntry(
          { id: "m-preferred", slug: "kimi-k2.6", display_name: "Kimi K2.6", preferred_rank: 1 },
          [{ provider: "openrouter", input_micro_usd_per_million: 541_500 }]
        ),
        // Org-owned (so the filter keeps it) with no routes: folds into its
        // family band and prices as "—".
        makeEntry(
          {
            id: "m-plain",
            slug: "qwen3.5-4b",
            display_name: "Qwen 3.5 4B",
            context_window: null,
            owning_org_id: "org-1"
          },
          []
        )
      ],
      total: 2,
      limit: 1000,
      offset: 0
    });

    const { container } = render(await ModelsPage());

    // Round-2: no page title — the toolbar is the top edge.
    expect(container.querySelector("h1")).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
    // Recommended (preferred) models lead in their own always-open band; every
    // model also folds into its family section below (the product owner, r2; amended
    // 2026-08-24: the band is an additive overlay, so Kimi's family fold
    // exists too instead of the starred model vanishing from it).
    const bands = [...container.querySelectorAll("tbody .mono-label")].map(
      (node) => node.textContent
    );
    expect(bands).toEqual(["Recommended", "Kimi", "Qwen"]);
    // The recommended model is visible up front and priced.
    expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    expect(screen.getByText("$0.54")).toBeInTheDocument();
    // The non-recommended Qwen row is folded away until its band is expanded.
    expect(screen.queryByText("Qwen 3.5 4B")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Qwen/ }));
    // Expanded: a model with no routes shows — , never $0.
    const plainRow = screen.getByText("Qwen 3.5 4B").closest("tr");
    expect(plainRow?.textContent).toContain("—");
    expect(plainRow?.textContent).not.toContain("$0");
  });

  it("renders every advertised filter and the add-model door once unlocked", async () => {
    signInWithConnections(["openai"]);
    fetchPublicCatalog.mockResolvedValue({ models: [makeEntry()], total: 1, limit: 1000, offset: 0 });

    render(await ModelsPage());

    for (const label of ["Provider", "Modality", "Params", "Context", "Price", "Age"]) {
      // Exact-name match: "Provider" is the filter pill, "Provider routes"
      // the view tab.
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Cache discount" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add model/ })).toHaveAttribute(
      "href",
      "/models/new"
    );
  });

  it("opens for an org that owns a model even without a provider connection", async () => {
    signInWithConnections([]);
    fetchOrgOwnedModels.mockResolvedValue({
      models: [makeEntry({ id: "m-own", slug: "own-local", display_name: "Own Local" }, [])],
      total: 1,
      limit: 1000,
      offset: 0
    });
    fetchPublicCatalog.mockResolvedValue({
      models: [
        // Public model on an unconnected provider: hidden even though the
        // gate is open through the org's own model.
        makeEntry({ id: "m-pub", slug: "gpt-6", display_name: "GPT-6", preferred_rank: 1 }, [
          { provider: "openai" }
        ]),
        makeEntry(
          {
            id: "m-own-pub",
            slug: "own-local",
            display_name: "Own Local",
            preferred_rank: 2,
            owning_org_id: "org-1"
          },
          [{ provider: "local" }]
        )
      ],
      total: 2,
      limit: 1000,
      offset: 0
    });

    render(await ModelsPage());

    expect(screen.queryByText("Connect a provider to see models")).toBeNull();
    expect(screen.getByText("Own Local")).toBeInTheDocument();
    expect(screen.queryByText("GPT-6")).toBeNull();
  });
});

describe("model detail (public, signed out)", () => {
  it("renders the ways-to-use block, quickstart, and actions for an ordinary slug", async () => {
    const entry = makeEntry(
      { id: "m-1", slug: "tau-bench", display_name: "Tau Bench" },
      [
        {
          provider: "anthropic",
          input_micro_usd_per_million: 3_000_000,
          uptime_30d: 99.98,
          stats_source: "openrouter"
        },
        { provider: "bedrock", input_micro_usd_per_million: null }
      ]
    );
    fetchModelDetail.mockResolvedValue(makeDetail(entry));

    const { container } = render(await ModelPage(pageProps("tau-bench")));

    expect(container.querySelector("h1")?.textContent).toBe("Tau Bench");
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
    // The consolidated "Ways to use this model" block (providers table,
    // waterfall, add-local-variant, and use-via-key folded into one). Its rows
    // and the embedded key flow read from keys-P7's store, covered live.
    expect(screen.getByTestId("ways-to-use")).toBeInTheDocument();
    // Quickstart, prompt-first, authenticated with the org key placeholder.
    expect(screen.getByTestId("quickstart-card").textContent).toContain("EXPLABS_API_KEY");
    // Actions: playground deep link and compare.
    expect(screen.getByRole("link", { name: /Open in Playground/ })).toHaveAttribute(
      "href",
      "/playground?model=tau-bench"
    );
    expect(screen.getByRole("link", { name: /Compare/ })).toHaveAttribute(
      "href",
      "/models/compare?models=tau-bench"
    );
    // Track-not-show: no activity/usage anywhere on the page.
    expect(container.textContent?.toLowerCase()).not.toContain("activity");
  });

  it("404s an unknown slug", async () => {
    fetchModelDetail.mockResolvedValue(null);
    await expect(ModelPage(pageProps("nope"))).rejects.toThrow("not-found");
  });

  it("still sends a reserved slug to its real page", async () => {
    // The reserved-slug guard is a routing collision, not an audience question:
    // /models/logs is the Logs page, never a model named "logs". The renamed
    // old nouns still land on their new page.
    await expect(ModelPage(pageProps("logs"))).rejects.toThrow("redirect:/logs");
    await expect(ModelPage(pageProps("telemetry"))).rejects.toThrow("redirect:/logs");
  });

  it("404s a reserved slug with no landing page", async () => {
    await expect(ModelPage(pageProps("api"))).rejects.toThrow("not-found");
    expect(redirect).not.toHaveBeenCalled();
  });
});
