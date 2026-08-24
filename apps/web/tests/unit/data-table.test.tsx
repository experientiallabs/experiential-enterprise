import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push })
}));

import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";

type Row = { id: string; name: string; price: number | null; band: string };

const COLUMNS: Array<DataTableColumn<Row>> = [
  { id: "name", header: "Name", cell: (row) => row.name, sortValue: (row) => row.name },
  {
    id: "price",
    header: "Price",
    align: "right",
    defaultDirection: "asc",
    sortValue: (row) => row.price,
    cell: (row) => (row.price === null ? "—" : `$${row.price}`)
  }
];

const ROWS: Row[] = [
  { id: "1", name: "bravo", price: 3, band: "all" },
  { id: "2", name: "alpha", price: null, band: "all" },
  { id: "3", name: "charlie", price: 1, band: "all" }
];

function cellTexts(container: HTMLElement, column: number): string[] {
  return [...container.querySelectorAll("tbody tr")]
    .filter((row) => row.querySelectorAll("td").length > 1)
    .map((row) => row.querySelectorAll("td")[column].textContent ?? "");
}

afterEach(() => vi.clearAllMocks());

describe("DataTable", () => {
  it("keeps the given order until a header is clicked, then sorts nulls last", () => {
    const { container } = render(<DataTable columns={COLUMNS} rowKey={(r) => r.id} rows={ROWS} />);
    expect(cellTexts(container, 0)).toEqual(["bravo", "alpha", "charlie"]);

    // First click: the column's natural direction; unknown prices sort last.
    fireEvent.click(screen.getByRole("button", { name: "Sort by price" }));
    expect(cellTexts(container, 1)).toEqual(["$1", "$3", "—"]);

    // Second click flips, unknowns still last (never fake-extreme).
    fireEvent.click(screen.getByRole("button", { name: "Sort by price" }));
    expect(cellTexts(container, 1)).toEqual(["$3", "$1", "—"]);

    // Third click returns to the caller's order.
    fireEvent.click(screen.getByRole("button", { name: "Sort by price" }));
    expect(cellTexts(container, 0)).toEqual(["bravo", "alpha", "charlie"]);
  });

  it("sorts within bands while bands keep their order", () => {
    const rows: Row[] = [
      { id: "p1", name: "zeta", price: 9, band: "preferred" },
      { id: "a1", name: "alpha", price: 1, band: "all" },
      { id: "p2", name: "echo", price: 2, band: "preferred" }
    ];
    const { container } = render(
      <DataTable
        columns={COLUMNS}
        groupKey={(row) => row.band}
        renderGroupHeader={(key) => <span>{key}</span>}
        rowKey={(row) => row.id}
        rows={rows}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort by price" }));
    // Preferred band stays pinned above "all" even though alpha is cheapest.
    expect(cellTexts(container, 0)).toEqual(["echo", "zeta", "alpha"]);
    expect(screen.getByText("preferred")).toBeInTheDocument();
    expect(screen.getByText("all")).toBeInTheDocument();
  });

  it("folds the initially-collapsed bands and expands one on click", () => {
    const rows: Row[] = [
      { id: "p1", name: "zeta", price: 9, band: "recommended" },
      { id: "a1", name: "alpha", price: 1, band: "all" },
      { id: "a2", name: "echo", price: 2, band: "all" }
    ];
    const { container } = render(
      <DataTable
        collapsibleGroups
        columns={COLUMNS}
        groupKey={(row) => row.band}
        initialCollapsedGroup={(key) => key !== "recommended"}
        renderGroupHeader={(key, count) => (
          <span>
            {key} {count}
          </span>
        )}
        rowKey={(row) => row.id}
        rows={rows}
      />
    );
    // The recommended band is open; the "all" band is folded with its count.
    expect(cellTexts(container, 0)).toEqual(["zeta"]);
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.getByRole("button", { name: /all 2/ })).toBeInTheDocument();

    // Expanding the folded band reveals its rows without hiding recommended.
    fireEvent.click(screen.getByRole("button", { name: /all 2/ }));
    expect(cellTexts(container, 0)).toEqual(["zeta", "alpha", "echo"]);

    // And it collapses again on a second click.
    fireEvent.click(screen.getByRole("button", { name: /all 2/ }));
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("navigates on row click but not on inner interactive elements", () => {
    const columns: Array<DataTableColumn<Row>> = [
      { id: "name", header: "Name", cell: (row) => <a href={`/x/${row.id}`}>{row.name}</a> }
    ];
    render(
      <DataTable
        columns={columns}
        rowHref={(row) => `/rows/${row.id}`}
        rowKey={(row) => row.id}
        rows={ROWS}
      />
    );
    const row = screen.getByText("bravo").closest("tr");
    fireEvent.click(row!.querySelector("td")!);
    expect(push).toHaveBeenCalledWith("/rows/1");
    push.mockClear();
    fireEvent.click(screen.getByText("bravo"));
    expect(push).not.toHaveBeenCalled();
  });

  it("renders the empty state across all columns", () => {
    render(
      <DataTable
        columns={COLUMNS}
        emptyState={<p>Nothing matches</p>}
        rowKey={(row) => row.id}
        rows={[]}
      />
    );
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
  });
});
