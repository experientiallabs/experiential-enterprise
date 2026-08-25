import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/models",
  useSearchParams: () => new URLSearchParams()
}));

import { CatalogTable } from "@/components/models-catalog/catalog-table";
import type { ModelPromotion } from "@/lib/models-catalog/types";
import { makeEntry } from "./models-catalog-fixtures";

afterEach(() => vi.clearAllMocks());

const entries = [
  makeEntry({ id: "m-luna", slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna" }),
  makeEntry({ id: "m-ds", slug: "deepseek-v4-flash", display_name: "DeepSeek V4 Flash" }),
  // Also Recommended, so it renders in the always-open band and we can assert it
  // appears in BOTH the Promotional section and its normal band.
  makeEntry({ id: "m-qwen", slug: "qwen3.8-27b", display_name: "Qwen3.8 27B", preferred_rank: 1 }),
  makeEntry({ id: "m-other", slug: "some-other", display_name: "Some Other" })
];

const promotions: ModelPromotion[] = [
  {
    label: "Free tier",
    slugs: ["qwen3.8-27b", "deepseek-v4-flash"],
    display_order: 0,
    free: true,
    percent_off: 0,
    providers: [],
    family_keys: []
  },
  {
    label: "GPT half off",
    slugs: ["gpt-5.6-luna"],
    display_order: 1,
    free: false,
    percent_off: 50,
    providers: ["experiential_cloud"],
    family_keys: ["openai"]
  }
];

function headerByText(text: string): HTMLElement {
  const header = screen
    .getAllByRole("button")
    .find((button) => button.hasAttribute("aria-expanded") && button.textContent?.includes(text));
  if (header === undefined) {
    throw new Error(`No group header containing "${text}"`);
  }
  return header;
}

describe("catalog Promotional table section", () => {
  it("renders the Promotional section as the FIRST table band, in promo display order", () => {
    const { container } = render(<CatalogTable entries={entries} promotions={promotions} />);
    // The old card band above the table is gone; the testid now lives on the
    // section's header row inside the table.
    expect(container.querySelector('section[data-testid="promotional-section"]')).toBeNull();
    const marker = screen.getByTestId("promotional-section");
    expect(marker.closest("table")).not.toBeNull();
    expect(marker.textContent).toContain("Promotional");
    expect(marker.textContent).toContain("3");

    const headerRows = [...container.querySelectorAll("tbody button[aria-expanded]")];
    expect(headerRows[0]?.textContent).toContain("Promotional");
    expect(headerRows[1]?.textContent).toContain("Recommended");

    // Rows in the section follow promotion display_order (free promo first).
    const sectionRows = rowsBetweenHeaders(container, "Promotional", "Recommended");
    expect(sectionRows[0]).toContain("Qwen3.8 27B");
    expect(sectionRows[1]).toContain("DeepSeek V4 Flash");
    expect(sectionRows[2]).toContain("GPT-5.6 Luna");
  });

  it("sorts families carrying a percent-promo chip ahead of the other families", () => {
    const { container } = render(<CatalogTable entries={entries} promotions={promotions} />);
    const headerTexts = [...container.querySelectorAll("tbody button[aria-expanded]")].map(
      (button) => button.textContent ?? ""
    );
    expect(headerTexts[0]).toContain("Promotional");
    expect(headerTexts[1]).toContain("Recommended");
    // GPT leads the families because a percent promo names its family key —
    // a data-driven rule, so the unpromoted families follow in their usual order.
    expect(headerTexts[2]).toContain("GPT");
    const deepseekIndex = headerTexts.findIndex((text) => text.includes("DeepSeek"));
    expect(deepseekIndex).toBeGreaterThan(2);
  });

  it("shows exactly one chip per family header when several promos target it", () => {
    render(
      <CatalogTable
        entries={entries}
        promotions={[
          ...promotions,
          {
            label: "GPT extra",
            slugs: ["gpt-5.6-luna"],
            display_order: 5,
            free: false,
            percent_off: 10,
            providers: [],
            family_keys: ["openai"]
          }
        ]}
      />
    );
    const header = headerByText("GPT");
    // The lowest display_order promo wins the header slot; the later one
    // never stacks a second chip.
    expect(header.textContent).toContain("50% off");
    expect(header.textContent).not.toContain("10% off");
  });

  it("renders exactly ONE ranked chip on an overlapping model — FREE wins", () => {
    render(
      <CatalogTable
        entries={entries}
        promotions={[
          {
            label: "Luna free tier",
            slugs: ["gpt-5.6-luna"],
            display_order: 0,
            free: true,
            percent_off: 0,
            providers: [],
            family_keys: []
          },
          promotions[1]
        ]}
      />
    );
    // Luna is covered by BOTH a free promo and the 50% promo; its row wears
    // only the FREE chip (free outranks percent — the ranking helper's rule).
    // The 50% chip still marks the GPT family header, so scope to the row.
    const row = screen.getByText("GPT-5.6 Luna").closest("tr");
    expect(row?.textContent).toContain("free");
    expect(row?.textContent).not.toContain("50% off");
  });

  it("defaults Promotional and Recommended open and every family section closed", () => {
    render(<CatalogTable entries={entries} promotions={promotions} />);
    expect(headerByText("Promotional")).toHaveAttribute("aria-expanded", "true");
    expect(headerByText("Recommended")).toHaveAttribute("aria-expanded", "true");
    expect(headerByText("GPT")).toHaveAttribute("aria-expanded", "false");
    expect(headerByText("DeepSeek")).toHaveAttribute("aria-expanded", "false");
    // A collapsed family hides its rows, so Luna shows only in the Promotional
    // section until its family is expanded.
    expect(screen.getAllByText("GPT-5.6 Luna")).toHaveLength(1);
    fireEvent.click(headerByText("GPT"));
    expect(screen.getAllByText("GPT-5.6 Luna")).toHaveLength(2);
  });

  it("keeps a promoted model in its normal band too (appears in both)", () => {
    render(<CatalogTable entries={entries} promotions={promotions} />);
    // Qwen is Recommended (open by default), so it is visible twice at once.
    expect(screen.getAllByText("Qwen3.8 27B")).toHaveLength(2);
    // The Recommended band is additive: the same model still lists under its
    // own (collapsed by default) family fold.
    fireEvent.click(headerByText("Qwen"));
    expect(screen.getAllByText("Qwen3.8 27B")).toHaveLength(3);
  });

  it("keeps recommended models listed in their family fold (GPT-5.6 Sol/Luna regression)", () => {
    // Prod shape from 2026-08-24: Sol/Luna are starred AND in a free promo;
    // Terra only rides a family-scoped percent promo. The old band partition
    // MOVED starred models out of their family, so the GPT fold showed Terra
    // but not Sol/Luna. Rails must overlay, never subtract.
    const rows = [
      makeEntry({ id: "m-sol", slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", preferred_rank: 1 }),
      makeEntry({ id: "m-luna2", slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", preferred_rank: 2 }),
      makeEntry({ id: "m-terra", slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra" })
    ];
    const promos: ModelPromotion[] = [
      {
        label: "Founders free",
        slugs: ["gpt-5.6-sol", "gpt-5.6-luna"],
        display_order: 0,
        free: true,
        percent_off: 0,
        providers: [],
        family_keys: []
      },
      {
        label: "GPT half off",
        slugs: [],
        display_order: 1,
        free: false,
        percent_off: 50,
        providers: [],
        family_keys: ["openai"]
      }
    ];
    render(<CatalogTable entries={rows} promotions={promos} />);
    // Sol renders in Promotional and Recommended (both open); its family fold
    // is collapsed, so no third instance yet. Terra has no rail membership and
    // stays hidden until the fold opens.
    expect(screen.getAllByText("GPT-5.6 Sol")).toHaveLength(2);
    expect(screen.queryByText("GPT-5.6 Terra")).toBeNull();
    fireEvent.click(headerByText("GPT"));
    expect(screen.getAllByText("GPT-5.6 Sol")).toHaveLength(3);
    expect(screen.getAllByText("GPT-5.6 Luna")).toHaveLength(3);
    expect(screen.getAllByText("GPT-5.6 Terra")).toHaveLength(1);
  });

  it("puts a FREE chip on free-promo models in every section they appear in", () => {
    render(<CatalogTable entries={entries} promotions={promotions} />);
    // Qwen twice (Promotional + Recommended) and DeepSeek once (Promotional;
    // its family band is collapsed). The percent-only promo gets no FREE chip.
    expect(screen.getAllByText("free")).toHaveLength(3);
    fireEvent.click(headerByText("DeepSeek"));
    expect(screen.getAllByText("free")).toHaveLength(4);
  });

  it("keeps FREE chip copy bare and moves the lane scope into the hover title", () => {
    render(
      <CatalogTable
        entries={entries}
        promotions={[
          {
            label: "EC free tier",
            slugs: ["qwen3.8-27b"],
            display_order: 0,
            free: true,
            percent_off: 0,
            providers: ["experiential_cloud"],
            family_keys: []
          }
        ]}
      />
    );
    // Qwen is Recommended too, so the chip renders in both open sections; the
    // visible copy stays "FREE", the lane honesty rides the tooltip.
    const chips = screen.getAllByText("free");
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip).toHaveAttribute("title", "Free when served via Experiential Cloud");
    }
    expect(screen.queryByText(/via Experiential Cloud/)).not.toBeInTheDocument();
  });

  it("renders the percent chip as bare '50% off' with the lane in the tooltip", () => {
    render(<CatalogTable entries={entries} promotions={promotions} />);
    const chips = screen.getAllByText("50% off");
    // One on the GPT family header, one on Luna's Promotional row, and one on
    // the Promotional header (exactly one percent promo covers the section).
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip).toHaveAttribute("title", "50% off when served via Experiential Cloud");
    }
    // The lane never renders as visible chip text anymore.
    expect(screen.queryByText(/via Experiential Cloud/)).not.toBeInTheDocument();
    expect(headerByText("GPT").textContent).toContain("50% off");
    expect(screen.getByTestId("promotional-section").textContent).toContain("50% off");
  });

  it("drops the header percent chip when several percent promos cover the section", () => {
    render(
      <CatalogTable
        entries={entries}
        promotions={[
          ...promotions,
          {
            label: "DeepSeek deal",
            slugs: ["deepseek-v4-flash"],
            display_order: 2,
            free: false,
            percent_off: 20,
            providers: [],
            family_keys: ["deepseek"]
          }
        ]}
      />
    );
    expect(screen.getByTestId("promotional-section").textContent).not.toContain("% off");
    // Luna's row chip still shows its percent deal; DeepSeek's 20% marks its
    // family header (its own row ranks the free promo's chip above it).
    expect(screen.getAllByText("50% off").length).toBeGreaterThan(0);
    expect(screen.getAllByText("20% off").length).toBeGreaterThan(0);
  });

  it("renders no Promotional section when there are no promotions", () => {
    render(<CatalogTable entries={entries} promotions={[]} />);
    expect(screen.queryByTestId("promotional-section")).not.toBeInTheDocument();
  });

  it("ignores a promotion whose models are not in the catalog", () => {
    render(
      <CatalogTable
        entries={entries}
        promotions={[
          {
            label: "Ghost",
            slugs: ["not-in-catalog"],
            display_order: 0,
            free: true,
            percent_off: 0,
            providers: [],
            family_keys: []
          }
        ]}
      />
    );
    expect(screen.queryByTestId("promotional-section")).not.toBeInTheDocument();
  });

  it("prices a promoted row as list-price struck through beside the effective price", () => {
    const { container } = render(<CatalogTable entries={entries} promotions={promotions} />);
    const struck = [...container.querySelectorAll('[data-testid="promo-price"]')];
    // Every promoted, priced row carries the crossed-out list price; a free
    // promo's effective price is $0 (only ever the PROMO price, never unknown).
    expect(struck.length).toBeGreaterThan(0);
    expect(struck.some((node) => node.querySelector("s") !== null)).toBe(true);
  });
});

/** Visible row texts between two group headers, top to bottom. */
function rowsBetweenHeaders(container: HTMLElement, from: string, to: string): string[] {
  const rows = [...container.querySelectorAll("tbody tr")];
  const texts: string[] = [];
  let inside = false;
  for (const row of rows) {
    const headerButton = row.querySelector("button[aria-expanded]");
    if (headerButton) {
      if (headerButton.textContent?.includes(from)) {
        inside = true;
        continue;
      }
      if (headerButton.textContent?.includes(to)) {
        break;
      }
      continue;
    }
    if (inside) {
      texts.push(row.textContent ?? "");
    }
  }
  return texts;
}
