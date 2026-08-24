import type { ReactNode } from "react";
import Link from "next/link";

import type { RankedRow } from "@/lib/activity-usage";

// A ranked bar list (the Activity dashboard's top-models / top-keys / providers
// panels), matching the insight-cards bar idiom: a label, a formatted value,
// an optional count, and a share bar of the leader.
type RankedListProps = {
  rows: RankedRow[];
  /** Formats each row's headline value in the panel's units (money, count). */
  format: (value: number) => string;
  /** Optional leading glyph per row (e.g. a provider logo). */
  renderLeading?: (row: RankedRow) => ReactNode;
  /** Optional destination per row (e.g. a model's catalog page); null rows stay flat. */
  href?: (row: RankedRow) => string | null;
  /** Shown when there is nothing to rank this window. */
  emptyLabel: string;
};

export function RankedList({ rows, format, renderLeading, href, emptyLabel }: RankedListProps) {
  if (rows.length === 0) {
    return <p className="m-0 text-[12px] text-muted-2">{emptyLabel}</p>;
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((row) => {
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5">
                {renderLeading?.(row)}
                <span className="truncate text-[12px] text-ink">{row.label}</span>
              </span>
              <span className="shrink-0 text-[12px] font-medium tabular-nums text-ink">
                {format(row.value)}
                {row.detail !== null && (
                  <span className="ml-1.5 font-normal text-muted-2">{row.detail}</span>
                )}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.round(row.fraction * 100)}%` }}
              />
            </div>
          </>
        );
        const to = href?.(row) ?? null;
        return (
          <li key={row.key}>
            {to === null ? (
              <div className="flex flex-col gap-1 py-0.5">{body}</div>
            ) : (
              <Link
                className="-mx-1.5 flex flex-col gap-1 rounded-[var(--radius-md)] px-1.5 py-0.5 hover:bg-surface-subtle"
                href={to}
              >
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
