import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /models flash fix: the page renders the shared cached PUBLIC base
// server-side (no per-visit auth or overlay round trip, so the load boundary
// never blanks), and the signed-in viewer's own custom models are hydrated
// CLIENT-side over that base. These suites pin both halves of that seam — the
// GET /api/models overlay route (scoped to the ACTIVE org) and CatalogTable's
// client merge (an org model shadows the public one of the same slug).

const getAuthenticatedUser = vi.hoisted(() => vi.fn());
const fetchOrgOwnedModels = vi.hoisted(() => vi.fn());
const resolveActiveOrg = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));
vi.mock("@/lib/active-org", () => ({ resolveActiveOrg }));
vi.mock("@/lib/models-catalog/server", () => ({
  fetchOrgOwnedModels,
  // The POST handler pulls this; the GET path never touches it.
  revalidateModelsCatalog: vi.fn()
}));
vi.mock("@/lib/data-source", () => ({ getDataSource: () => ({ createCatalogModel: vi.fn() }) }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/models",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { GET } from "@/app/api/models/route";
import { CatalogTable } from "@/components/models-catalog/catalog-table";
import { makeEntry } from "./models-catalog-fixtures";

beforeEach(() => {
  getAuthenticatedUser.mockReset();
  fetchOrgOwnedModels.mockReset();
  resolveActiveOrg.mockReset();
  vi.unstubAllGlobals();
});

describe("GET /api/models (signed-in org overlay)", () => {
  it("returns an empty overlay for a signed-out caller without hitting the backend", async () => {
    getAuthenticatedUser.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ models: [], total: 0 });
    expect(fetchOrgOwnedModels).not.toHaveBeenCalled();
  });

  it("scopes the overlay to the active org, filtering out other orgs' models", async () => {
    getAuthenticatedUser.mockResolvedValue({ id: "user-1" });
    resolveActiveOrg.mockResolvedValue({ id: "org-1", name: "Acme" });
    // The backend owner=org list spans every org the actor belongs to; the
    // route must keep only the active org's rows.
    fetchOrgOwnedModels.mockResolvedValue({
      models: [
        makeEntry({ id: "m-a", slug: "acme-custom", owning_org_id: "org-1" }),
        makeEntry({ id: "m-b", slug: "other-custom", owning_org_id: "org-2" })
      ],
      total: 2,
      limit: 1000,
      offset: 0
    });
    const response = await GET();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { models: { model: { slug: string } }[]; total: number };
    expect(payload.total).toBe(1);
    expect(payload.models.map((entry) => entry.model.slug)).toEqual(["acme-custom"]);
    // The acting org rides along so the backend narrows promotion
    // audiences to it (not any org the user belongs to).
    expect(fetchOrgOwnedModels).toHaveBeenCalledWith("user-1", "org-1");
  });
});

describe("CatalogTable client overlay", () => {
  it("paints the public base immediately, then merges the org overlay", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        models: [
          makeEntry({ id: "m-org", slug: "acme-custom", display_name: "Acme Custom", preferred_rank: 2 })
        ],
        total: 1,
        limit: 1000,
        offset: 0
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CatalogTable
        entries={[
          makeEntry({ id: "m-pub", slug: "kimi-k2.6", display_name: "Kimi K2.6", preferred_rank: 1 })
        ]}
        hydrateOrgModels
      />
    );

    // The base row is present on first paint (no dependence on the overlay).
    expect(screen.getByText("Kimi K2.6")).toBeInTheDocument();
    // The overlay hydrates in and merges over the base.
    await waitFor(() => expect(screen.getByText("Acme Custom")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/models?owner=org", { cache: "no-store" });
  });

  it("shadows the public model when the org overlay carries the same slug", async () => {
    // Same slug, different id: the org row must REPLACE the public one, never
    // render a second conflicting row for the slug.
    const fetchMock = vi.fn(async () =>
      Response.json({
        models: [
          makeEntry({ id: "m-org", slug: "kimi-k2.6", display_name: "Kimi Custom", preferred_rank: 1 })
        ],
        total: 1,
        limit: 1000,
        offset: 0
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CatalogTable
        entries={[
          makeEntry({ id: "m-pub", slug: "kimi-k2.6", display_name: "Kimi K2.6", preferred_rank: 1 })
        ]}
        hydrateOrgModels
      />
    );

    await waitFor(() => expect(screen.getByText("Kimi Custom")).toBeInTheDocument());
    // The public row for the shadowed slug is gone (one row per slug).
    expect(screen.queryByText("Kimi K2.6")).not.toBeInTheDocument();
  });

  it("swaps in the viewer's audience-resolved promotions from the overlay", async () => {
    // Server render painted the ANONYMOUS promo set (label-scoped promos
    // withheld); the hydrate response carries the viewer's set, which must
    // replace it (here: a YC-only 50% promo appearing for a YC org viewer).
    const fetchMock = vi.fn(async () =>
      Response.json({
        models: [],
        promotions: [
          {
            label: "yc half off",
            slugs: ["kimi-k2.6"],
            display_order: 0,
            free: false,
            percent_off: 50,
            providers: [],
            family_keys: []
          }
        ],
        total: 0,
        limit: 1000,
        offset: 0
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CatalogTable
        entries={[
          makeEntry({ id: "m-pub", slug: "kimi-k2.6", display_name: "Kimi K2.6", preferred_rank: 1 })
        ]}
        hydrateOrgModels
        promotions={[]}
      />
    );

    // No promotional band on first paint (anonymous set was empty)...
    expect(screen.queryByText(/50% off/i)).not.toBeInTheDocument();
    // ...and the viewer's promotions hydrate in.
    await waitFor(() => expect(screen.getAllByText(/50% off/i).length).toBeGreaterThan(0));
    // The band itself resolves against the hydrated set too: a discounted price
    // with no Promotional section is the display-honesty gap #791 closed.
    expect(screen.getByTestId("promotional-section").textContent).toContain("Promotional");
  });

  it("drops the Promotional band when the viewer's set withholds an anonymous promo", async () => {
    // The reverse swap: the server painted a promo the signed-in viewer is not
    // eligible for, so hydration must retire the band, not keep the stale one.
    const fetchMock = vi.fn(async () =>
      Response.json({ models: [], promotions: [], total: 0, limit: 1000, offset: 0 })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CatalogTable
        entries={[
          makeEntry({ id: "m-pub", slug: "kimi-k2.6", display_name: "Kimi K2.6", preferred_rank: 1 })
        ]}
        hydrateOrgModels
        promotions={[
          {
            label: "launch week",
            slugs: ["kimi-k2.6"],
            display_order: 0,
            free: true,
            percent_off: 0,
            providers: [],
            family_keys: []
          }
        ]}
      />
    );

    expect(screen.getByTestId("promotional-section")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("promotional-section")).not.toBeInTheDocument());
  });

  it("never fetches an overlay when hydrateOrgModels is off (compare board)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CatalogTable entries={[makeEntry({ id: "m-pub", slug: "kimi-k2.6" })]} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
