import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/models",
  useSearchParams: () => new URLSearchParams()
}));

import { CatalogTable } from "@/components/models-catalog/catalog-table";
import { makeEntry } from "./models-catalog-fixtures";

afterEach(() => vi.clearAllMocks());

const LONG_WIRE = "accounts/fireworks/models/deepseek-v4-flash-0731-extremely-long-wire";

const entries = [
  makeEntry({ id: "m-a", slug: "short", display_name: "Short" }, [
    { provider: "fireworks", provider_model_id: LONG_WIRE }
  ])
];

describe("catalog table adaptive column widths", () => {
  // jsdom does no real layout, so the pin is structural: the columns adapt to
  // whichever section is open BECAUSE the table is auto-layout (min-w-max, no
  // table-fixed) and no cell carries a fixed width clamp — a max-w on the
  // routes-view wire id used to freeze that column and ellipsize long
  // Fireworks/Bedrock ids when a section with longer slugs expanded (the product owner r3).
  it("keeps the table auto-layout so columns size to the open sections", () => {
    render(<CatalogTable entries={entries} />);
    const table = screen.getByRole("table", { name: "Model catalog" });
    expect(table.className).toContain("min-w-max");
    expect(table.className).not.toContain("table-fixed");
  });

  it("never clamps the routes-view wire id to a fixed width", () => {
    render(<CatalogTable entries={entries} />);
    fireEvent.click(screen.getByText("Provider routes"));
    const wire = screen.getByText(LONG_WIRE);
    expect(wire.className).not.toMatch(/max-w-|truncate/);
  });

  it("shows the Experiential Cloud badge first even when it is last in the entry", () => {
    render(
      <CatalogTable
        entries={[
          makeEntry({ id: "m-ec", slug: "flash", display_name: "Flash", preferred_rank: 1 }, [
            { id: "or", provider: "openrouter", throughput_tps: 200 },
            { id: "ec", provider: "experiential_cloud", throughput_tps: 40 }
          ])
        ]}
      />
    );
    const badges = screen.getAllByText(/OpenRouter|Experiential Cloud/);
    expect(badges[0]).toHaveTextContent("Experiential Cloud");
    expect(badges[1]).toHaveTextContent("OpenRouter");
  });
});

describe("catalog toolbar actions", () => {
  // The toolbar pair is deliberately neutral (the product owner, 2026-08-24): Compare sits
  // left of Add model, both in the default white/gray variant, so the toolbar
  // has no accent CTA competing with the table.
  it("renders Compare left of Add model, both neutral, with the right hrefs", () => {
    render(<CatalogTable entries={entries} />);
    const compare = screen.getByRole("link", { name: /compare/i });
    const addModel = screen.getByRole("link", { name: /add model/i });
    expect(compare.getAttribute("href")).toBe("/models/compare");
    expect(addModel.getAttribute("href")).toBe("/models/new");
    expect(
      compare.compareDocumentPosition(addModel) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    for (const link of [compare, addModel]) {
      expect(link.className).toContain("bg-surface");
      expect(link.className).toContain("border-line-strong");
      expect(link.className).not.toContain("bg-accent");
    }
    expect(compare.querySelector("svg")).not.toBeNull();
  });

  it("suppresses the Compare link under controlled selection (compare page)", () => {
    render(
      <CatalogTable entries={entries} selection={{ selected: [], onToggle: () => undefined }} />
    );
    expect(screen.queryByRole("link", { name: /compare/i })).toBeNull();
    expect(screen.getByRole("link", { name: /add model/i })).not.toBeNull();
  });
});
