"use client";

// The house data-table primitive: dense, hairline-separated, sortable rows in
// the design system's table-first idiom (docs/design-system.md). Built for the
// models catalog and reusable by any workstream that renders row-level data —
// column defs carry their own cell renderers and sort accessors, so callers
// never re-implement header toggling, null-last ordering, or the row hover
// grammar. Grouped rows (the catalog's pinned "preferred" band) sort within
// their group while the groups keep their given order.

import {
  Fragment,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import { clsx } from "clsx";

export type SortDirection = "asc" | "desc";

export type DataTableSort = {
  columnId: string;
  direction: SortDirection;
};

export type DataTableColumn<Row> = {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Present = the header is a sort toggle. Null values always sort last. */
  sortValue?: (row: Row) => number | string | null;
  /** First click sorts this way; prices ascend, stats/dates descend. */
  defaultDirection?: SortDirection;
  align?: "left" | "right";
  /** Tailwind visibility for secondary columns, e.g. "hidden md:table-cell". */
  className?: string;
};

type DataTableProps<Row> = {
  columns: Array<DataTableColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Makes the whole row a navigation target (Enter works too). */
  rowHref?: (row: Row) => string | null;
  rowClassName?: (row: Row) => string | undefined;
  /** Rows partition into bands by this key; bands keep first-seen order. */
  groupKey?: (row: Row) => string;
  /** Band divider content, rendered when the group key changes; `count` is the
   * number of rows in the band. */
  renderGroupHeader?: (key: string, count: number) => ReactNode;
  /** Opt in to collapsible bands: headers become toggles with a chevron and a
   * row count, and collapsed bands hide their rows. Off by default, so every
   * existing caller keeps flat always-open bands. */
  collapsibleGroups?: boolean;
  /** Which bands start collapsed (only consulted when collapsibleGroups). The
   * catalog folds every non-recommended provider section by default. */
  initialCollapsedGroup?: (key: string) => boolean;
  /** Controlled sort; omit for internal state. Null = the given row order. */
  sort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  emptyState?: ReactNode;
  "aria-label"?: string;
};

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowClassName,
  groupKey,
  renderGroupHeader,
  collapsibleGroups = false,
  initialCollapsedGroup,
  sort: controlledSort,
  onSortChange,
  emptyState,
  "aria-label": ariaLabel
}: DataTableProps<Row>) {
  const router = useRouter();
  const [internalSort, setInternalSort] = useState<DataTableSort | null>(null);
  const sort = controlledSort !== undefined ? controlledSort : internalSort;
  // Bands start collapsed per the caller's predicate; toggling moves the key
  // into `overrides`, which wins over the predicate from then on.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const isCollapsed = (key: string) =>
    overrides.get(key) ?? (initialCollapsedGroup?.(key) ?? false);
  const toggleGroup = (key: string) =>
    setOverrides((current) => {
      const next = new Map(current);
      next.set(key, !isCollapsed(key));
      return next;
    });

  const setSort = (next: DataTableSort | null) => {
    if (onSortChange) {
      onSortChange(next);
    }
    if (controlledSort === undefined) {
      setInternalSort(next);
    }
  };

  const toggleSort = (column: DataTableColumn<Row>) => {
    if (!column.sortValue) {
      return;
    }
    const first = column.defaultDirection ?? "asc";
    if (sort === null || sort.columnId !== column.id) {
      setSort({ columnId: column.id, direction: first });
      return;
    }
    // Second click flips; third returns to the caller's natural order.
    if (sort.direction === first) {
      setSort({ columnId: column.id, direction: first === "asc" ? "desc" : "asc" });
      return;
    }
    setSort(null);
  };

  const ordered = useMemo(
    () => orderRows(rows, columns, sort, groupKey),
    [rows, columns, sort, groupKey]
  );

  const onRowActivate = (row: Row, event: MouseEvent | KeyboardEvent) => {
    const href = rowHref?.(row);
    if (!href) {
      return;
    }
    // A click that started on an interactive element inside the row (a link,
    // a checkbox, a button) belongs to that element, not to navigation.
    const target = event.target as HTMLElement;
    if (target.closest("a, button, input, select, label")) {
      return;
    }
    router.push(href);
  };

  return (
    <div className="min-h-0 grow overflow-auto rounded-lg border border-line bg-surface">
      <table aria-label={ariaLabel} className="w-full min-w-max border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line">
            {columns.map((column) => {
              const active = sort !== null && sort.columnId === column.id;
              const label = (
                <span
                  className={clsx(
                    "mono-label inline-flex items-center gap-1",
                    active && "text-foreground"
                  )}
                >
                  {column.header}
                  {active ? (
                    sort.direction === "asc" ? (
                      <ArrowUp aria-hidden size={11} strokeWidth={2} />
                    ) : (
                      <ArrowDown aria-hidden size={11} strokeWidth={2} />
                    )
                  ) : null}
                </span>
              );
              return (
                <th
                  className={clsx(
                    "whitespace-nowrap px-3 py-2.5 first:pl-4 last:pr-4",
                    column.align === "right" ? "text-right" : "text-left",
                    column.className
                  )}
                  key={column.id}
                  scope="col"
                >
                  {column.sortValue ? (
                    <button
                      aria-label={`Sort by ${column.id}`}
                      className="cursor-pointer bg-transparent p-0 hover:[&>span]:text-foreground"
                      onClick={() => toggleSort(column)}
                      type="button"
                    >
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.length === 0 && emptyState !== undefined ? (
            <tr>
              <td className="px-4 py-8" colSpan={columns.length}>
                {emptyState}
              </td>
            </tr>
          ) : null}
          {ordered.map(({ row, groupStart, bandKey, bandCount }) => {
            const href = rowHref?.(row);
            const rowHidden = collapsibleGroups && bandKey !== null && isCollapsed(bandKey);
            let header: ReactNode = null;
            if (groupStart !== null && renderGroupHeader) {
              const body = renderGroupHeader(groupStart, bandCount);
              header = collapsibleGroups ? (
                <tr className="border-b border-line bg-surface-subtle/60">
                  <td className="p-0" colSpan={columns.length}>
                    <button
                      aria-expanded={!isCollapsed(groupStart)}
                      className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left hover:bg-hover"
                      onClick={() => toggleGroup(groupStart)}
                      type="button"
                    >
                      {isCollapsed(groupStart) ? (
                        <ChevronRight aria-hidden className="shrink-0 text-ink-faint" size={13} />
                      ) : (
                        <ChevronDown aria-hidden className="shrink-0 text-ink-faint" size={13} />
                      )}
                      {body}
                    </button>
                  </td>
                </tr>
              ) : (
                <tr aria-hidden className="border-b border-line bg-surface-subtle/60">
                  <td className="px-4 py-1.5" colSpan={columns.length}>
                    {body}
                  </td>
                </tr>
              );
            }
            return (
              <Fragment key={rowKey(row)}>
                {header}
                {rowHidden ? null : (
                  <tr
                    className={clsx(
                      "border-b border-line last:border-b-0",
                      href &&
                        "cursor-pointer hover:bg-hover focus-visible:bg-hover focus-visible:outline-none",
                      rowClassName?.(row)
                    )}
                    onClick={(event) => onRowActivate(row, event)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && event.target === event.currentTarget) {
                        onRowActivate(row, event);
                      }
                    }}
                    role={href ? "link" : undefined}
                    tabIndex={href ? 0 : undefined}
                  >
                    {columns.map((column) => (
                      <td
                        className={clsx(
                          "whitespace-nowrap px-3 py-2.5 align-middle first:pl-4 last:pr-4",
                          column.align === "right" && "text-right",
                          column.className
                        )}
                        key={column.id}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type OrderedRow<Row> = {
  row: Row;
  /** The group key when this row opens a new band, else null. */
  groupStart: string | null;
  /** The band this row belongs to, or null when ungrouped. Lets the caller
   * hide the row when its band is collapsed while still drawing the header. */
  bandKey: string | null;
  /** Size of this row's band (1 when ungrouped). */
  bandCount: number;
};

function orderRows<Row>(
  rows: Row[],
  columns: Array<DataTableColumn<Row>>,
  sort: DataTableSort | null,
  groupKey: ((row: Row) => string) | undefined
): Array<OrderedRow<Row>> {
  const column = sort === null ? undefined : columns.find((c) => c.id === sort.columnId);
  const sortRows = (band: Row[]): Row[] => {
    if (!column?.sortValue || sort === null) {
      return band;
    }
    const accessor = column.sortValue;
    const known = band.filter((row) => accessor(row) !== null);
    const unknown = band.filter((row) => accessor(row) === null);
    known.sort((a, b) => {
      const va = accessor(a) as number | string;
      const vb = accessor(b) as number | string;
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return sort.direction === "asc" ? cmp : -cmp;
    });
    // Unknown values sort last in both directions: an unpriced route must not
    // pretend to be the cheapest or the most expensive.
    return [...known, ...unknown];
  };

  if (!groupKey) {
    return sortRows([...rows]).map((row) => ({
      row,
      groupStart: null,
      bandKey: null,
      bandCount: 1
    }));
  }
  const bands = new Map<string, Row[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const band = bands.get(key);
    if (band) {
      band.push(row);
    } else {
      bands.set(key, [row]);
    }
  }
  const ordered: Array<OrderedRow<Row>> = [];
  for (const [key, band] of bands) {
    sortRows(band).forEach((row, index) => {
      ordered.push({
        row,
        groupStart: index === 0 ? key : null,
        bandKey: key,
        bandCount: band.length
      });
    });
  }
  return ordered;
}
