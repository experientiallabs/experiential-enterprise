import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const push = vi.fn();
const fetchModelList = vi.hoisted(() => vi.fn());
const fetchModelDetail = vi.hoisted(() => vi.fn());
const getAuthenticatedUser = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push })
}));

// The board now mirrors selection to the URL with history.replaceState (no
// router navigation, so no server refetch on every click); spy on it.
let replaceState: ReturnType<typeof vi.spyOn>;
vi.mock("@/lib/models-catalog/server", () => ({ fetchModelList, fetchModelDetail }));
vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));

import CompareModelsPage from "@/app/(workspace)/models/compare/page";
import { CompareBoard } from "@/components/models-catalog/compare-board";
import { makeBenchmark, makeEntry } from "./models-catalog-fixtures";
import type { ModelBenchmarkExtras } from "@/lib/models-catalog/benchmarks";

// Preferred rank on every entry lands them in the always-open "Recommended"
// band, so the catalog-table picker renders their rows (and compare checkboxes)
// without a group first needing to be expanded.
const ENTRIES = [
  makeEntry(
    { id: "m-a", slug: "alpha", display_name: "Alpha", context_window: 200_000, preferred_rank: 1 },
    [{ id: "a-1", input_micro_usd_per_million: 1_000_000, throughput_tps: 80 }]
  ),
  makeEntry(
    { id: "m-b", slug: "bravo", display_name: "Bravo", context_window: 1_000_000, preferred_rank: 2 },
    [{ id: "b-1", input_micro_usd_per_million: 5_000_000, throughput_tps: 20 }]
  ),
  makeEntry({ id: "m-c", slug: "charlie", display_name: "Charlie", preferred_rank: 3 }, [{ id: "c-1" }]),
  makeEntry({ id: "m-d", slug: "delta", display_name: "Delta", preferred_rank: 4 }, [{ id: "d-1" }]),
  makeEntry({ id: "m-e", slug: "echo", display_name: "Echo", preferred_rank: 5 }, [{ id: "e-1" }])
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  getAuthenticatedUser.mockResolvedValue(null);
  fetchModelList.mockResolvedValue({ models: ENTRIES, total: 5, limit: 1000, offset: 0 });
  fetchModelDetail.mockResolvedValue(null);
  replaceState = vi.spyOn(window.history, "replaceState");
});

/** Detail-only extras for one compare column. */
function extras(overrides: Partial<ModelBenchmarkExtras> = {}): ModelBenchmarkExtras {
  return { benchmarks: [], huggingface_url: null, release_url: null, ...overrides };
}

const ALPHA_EXTRAS = extras({
  benchmarks: [
    makeBenchmark({ score: 90 }),
    makeBenchmark({
      benchmark: "latency-index",
      display_name: "Latency Index",
      unit: "points",
      higher_is_better: false,
      score: 5
    }),
    makeBenchmark({
      benchmark: "gpqa-diamond",
      display_name: "GPQA Diamond",
      score: 70
    })
  ],
  huggingface_url: "https://huggingface.co/org/alpha"
});

const BRAVO_EXTRAS = extras({
  benchmarks: [
    makeBenchmark({ score: 80 }),
    makeBenchmark({
      benchmark: "latency-index",
      display_name: "Latency Index",
      unit: "points",
      higher_is_better: false,
      score: 3
    })
  ]
});

describe("compare page (deep link, signed out)", () => {
  it("renders two models side by side cold from the URL", async () => {
    render(
      await CompareModelsPage({ searchParams: Promise.resolve({ models: "alpha,bravo" }) })
    );
    const matrix = within(screen.getByTestId("compare-matrix"));
    expect(matrix.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "/models/alpha");
    expect(matrix.getByRole("link", { name: "Bravo" })).toBeInTheDocument();
  });

  it("caps the comparison at four models and drops unknown slugs", async () => {
    render(
      await CompareModelsPage({
        searchParams: Promise.resolve({ models: "alpha,bravo,charlie,delta,echo,ghost" })
      })
    );
    const matrix = within(screen.getByTestId("compare-matrix"));
    expect(matrix.getByRole("link", { name: "Delta" })).toBeInTheDocument();
    // Echo is past the cap: it is not a comparison column (it still appears as a
    // pickable row in the catalog table below, which is expected).
    expect(matrix.queryByRole("link", { name: "Echo" })).toBeNull();
    expect(matrix.queryByText("ghost")).toBeNull();
  });

  it("shows the picker hint and no matrix below two models", async () => {
    render(await CompareModelsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByTestId("compare-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("compare-matrix")).toBeNull();
  });

  it("prefetches each selected model's benchmarks and renders the section cold", async () => {
    fetchModelDetail.mockImplementation(async (slug: string) => {
      const detailExtras = { alpha: ALPHA_EXTRAS, bravo: BRAVO_EXTRAS }[slug];
      if (detailExtras === undefined) {
        return null;
      }
      const entry = ENTRIES.find((candidate) => candidate.model.slug === slug);
      return { model: entry?.model, providers: [], default_waterfall: [], ...detailExtras };
    });
    render(
      await CompareModelsPage({ searchParams: Promise.resolve({ models: "alpha,bravo" }) })
    );
    expect(fetchModelDetail).toHaveBeenCalledWith("alpha");
    expect(fetchModelDetail).toHaveBeenCalledWith("bravo");
    const rows = screen.getAllByTestId("compare-benchmark-row");
    // Union of both models' lists, first-appearance order.
    expect(rows.map((row) => row.querySelector("th")?.textContent)).toEqual([
      "MMLU-Pro",
      "Latency Index",
      "GPQA Diamond"
    ]);
    // Higher-is-better row: alpha's 90% beats bravo's 80%.
    const mmluCells = [...rows[0].querySelectorAll("td")];
    expect(mmluCells[0]).toHaveAttribute("data-best", "true");
    expect(mmluCells[0].textContent).toBe("90.0%");
    expect(mmluCells[1]).not.toHaveAttribute("data-best");
    // Lower-is-better row: bravo's 3 beats alpha's 5.
    const latencyCells = [...rows[1].querySelectorAll("td")];
    expect(latencyCells[0]).not.toHaveAttribute("data-best");
    expect(latencyCells[1]).toHaveAttribute("data-best", "true");
    // A score only one model has renders a placeholder and highlights nothing.
    const gpqaCells = [...rows[2].querySelectorAll("td")];
    expect(gpqaCells[1].textContent).toBe("—");
    expect(rows[2].querySelector('[data-best="true"]')).toBeNull();
    // The open-weights column links its Hugging Face repo under the slug.
    const matrix = within(screen.getByTestId("compare-matrix"));
    expect(matrix.getByRole("link", { name: "Hugging Face" })).toHaveAttribute(
      "href",
      "https://huggingface.co/org/alpha"
    );
  });
});

describe("compare board", () => {
  it("lists Experiential Cloud first in the providers row even when it is last in input", () => {
    const flash = makeEntry(
      { id: "m-flash", slug: "flash", display_name: "Flash", preferred_rank: 1 },
      [
        { id: "or", provider: "openrouter", throughput_tps: 200 },
        { id: "ec", provider: "experiential_cloud", throughput_tps: 40 }
      ]
    );
    const other = makeEntry(
      { id: "m-other", slug: "other", display_name: "Other", preferred_rank: 2 },
      [{ id: "or-other", provider: "openrouter" }]
    );
    render(<CompareBoard entries={[flash, other]} selectedSlugs={["flash", "other"]} />);
    const providersRow = within(screen.getByTestId("compare-matrix"))
      .getByText("Providers")
      .closest("tr");
    expect(providersRow).not.toBeNull();
    const labels = within(providersRow as HTMLElement)
      .getAllByText(/OpenRouter|Experiential Cloud/)
      .map((node) => node.textContent);
    expect(labels[0]).toContain("Experiential Cloud");
  });

  it("offers Open in playground for the selection, and only from two models up", () => {
    const { rerender } = render(
      <CompareBoard entries={ENTRIES} selectedSlugs={["alpha", "bravo"]} />
    );
    const door = screen.getByTestId("open-in-playground");
    expect(door.getAttribute("href")).toBe("/playground?models=alpha,bravo");

    rerender(<CompareBoard entries={ENTRIES} selectedSlugs={["alpha"]} />);
    expect(screen.queryByTestId("open-in-playground")).toBeNull();
  });

  it("subtly highlights the best value per numeric row", () => {
    const { container } = render(
      <CompareBoard entries={ENTRIES} selectedSlugs={["alpha", "bravo"]} />
    );
    const bestCells = [
      ...within(screen.getByTestId("compare-matrix"))
        .getByRole("table")
        .querySelectorAll('[data-best="true"]')
    ].map((cell) => cell.textContent);
    // Alpha wins price and throughput; Bravo wins context. Rows with no known
    // values (uptime here) highlight nothing.
    expect(bestCells).toContain("$1");
    expect(bestCells).toContain("1M");
    expect(bestCells).toContain("80 tok/s");
    const uptimeRow = within(screen.getByTestId("compare-matrix")).getByText("Uptime (30d)").closest("tr");
    expect(uptimeRow?.querySelector('[data-best="true"]')).toBeNull();
    // The bespoke picker is gone; picking now uses the catalog table.
    expect(container.querySelector('[aria-label="Model catalog"]')).toBeInTheDocument();
  });

  it("checks a row instantly and mirrors it to the URL, without a router navigation", () => {
    render(<CompareBoard entries={ENTRIES} selectedSlugs={[]} />);
    const charlie = screen.getByRole("checkbox", { name: "Compare Charlie" });
    expect(charlie).not.toBeChecked();

    fireEvent.click(charlie);

    // Reflects immediately (optimistic), the URL updates in place, and no
    // router.replace fires (that would refetch the catalog under force-dynamic).
    expect(charlie).toBeChecked();
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/models/compare?models=charlie"
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("adds a second model through the same table, keeping the URL order", () => {
    render(<CompareBoard entries={ENTRIES} selectedSlugs={["alpha"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare Charlie" }));
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/models/compare?models=alpha,charlie"
    );
  });

  it("removes a model from its comparison column and by unchecking its row", () => {
    render(<CompareBoard entries={ENTRIES} selectedSlugs={["alpha", "bravo"]} />);

    // Column remove button.
    fireEvent.click(
      within(screen.getByTestId("compare-matrix")).getByRole("button", { name: "Remove Alpha" })
    );
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/models/compare?models=bravo"
    );

    // Unchecking the already-selected row does the same.
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare Bravo" }));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/models/compare");
  });

  it("lazily loads benchmarks for a model toggled in after the cold render", async () => {
    const detailFetch = vi.fn(async (url: string) => {
      const slug = decodeURIComponent(url.split("/").pop() ?? "");
      const entry = ENTRIES.find((candidate) => candidate.model.slug === slug);
      const detailExtras = slug === "bravo" ? BRAVO_EXTRAS : extras();
      return {
        ok: true,
        json: async () => ({
          model: entry?.model,
          providers: [],
          default_waterfall: [],
          ...detailExtras
        })
      };
    });
    vi.stubGlobal("fetch", detailFetch);
    render(
      <CompareBoard entries={ENTRIES} initialExtras={{ alpha: ALPHA_EXTRAS }} selectedSlugs={["alpha"]} />
    );
    // Alpha's extras came from the server, so nothing is fetched for it.
    expect(detailFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Compare Bravo" }));
    // Still an in-place URL mirror, never a router navigation.
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/models/compare?models=alpha,bravo"
    );
    expect(replace).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(detailFetch).toHaveBeenCalledWith("/api/models/bravo");
      const latency = screen
        .getAllByTestId("compare-benchmark-row")
        .find((row) => row.querySelector("th")?.textContent === "Latency Index");
      // Bravo's lazily loaded 3 beats alpha's server-provided 5 (lower wins).
      expect(latency?.querySelector('[data-best="true"]')?.textContent).toBe("3.0");
    });
  });
});
