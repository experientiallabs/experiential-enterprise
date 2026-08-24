// The one tile the published defaults render as, EVERYWHERE they appear: the
// unauthenticated door and the member catalog share this component verbatim
// (the product owner, 2026-07-30 - "same UI, same component"), and the workspace model
// cards compose the same pieces so an added default looks like the tile it was
// added from. Client-safe, no data access: callers hand it parsed rows.
import { clsx } from "clsx";

/** What the UI says wherever a measurement is absent. Never a figure, never a zero. */
export const NOT_YET_MEASURED = "not yet measured";

/** The card chrome every tile variant shares. */
export const TILE_CLASS = "flex h-full flex-col gap-3 rounded-lg border border-line bg-surface p-5";

/** Hover feedback for tiles that are themselves a door (links). */
export const TILE_LINK_CLASS =
  "transition-colors hover:border-line-strong hover:bg-surface-subtle";

/**
 * The axes a tile's evidence block reads. DefaultModelHeadline satisfies this
 * shape; a workspace endpoint's headline satisfies it once its stored report
 * measured both sides (the backend omits, never zeroes, missing axes).
 */
export type TileHeadline = {
  accuracy: number;
  baseline_accuracy?: number;
  savings_fraction: number;
  latency_savings_fraction?: number;
  /** Declared by "before optimization" reports; see isBaselineHeadline. */
  baseline_only?: boolean;
};

// One line, never two: a wrapped pill row gives tiles ragged heights. Overflow
// pans horizontally with the scrollbar hidden (no-scrollbar) so every tile
// keeps the same footprint regardless of how many tags a model carries.
export function TileTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) {
    return null;
  }
  return (
    <div className="no-scrollbar flex min-w-0 flex-nowrap gap-1.5 overflow-x-auto">
      {tags.map((tag) => (
        <span
          className="shrink-0 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs text-ink-soft"
          key={tag}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

/**
 * Title over an optional provenance line; the header every tile variant opens
 * with. Models are never captioned with the benchmark they were measured on
 * (the product owner, 2026-07-31: capability names, benchmark identity stays in the
 * evidence); the line renders only when the CALLER states a claim of its own,
 * e.g. a member's model genuinely "built from your traces".
 */
export function TileHeader({
  title,
  source
}: {
  title: string;
  /** Provenance line, the caller's own claim; omitted when absent. */
  source?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h2 className="m-0 truncate font-semibold tracking-tight text-ink">{title}</h2>
      {source !== undefined && <span className="mono-label truncate">{source}</span>}
    </div>
  );
}

/**
 * The signed accuracy gap vs the frontier anchor, in percentage points with one
 * decimal: the gaps are small (2 to 2.5 points) and whole-percent rounding
 * would turn a measured -2.5 into -3, a claim nobody made. The sign always
 * renders, minus included: some defaults sit slightly below the anchor and the
 * tile publishes that rather than flattering it.
 */
export function formatAccuracyDelta(accuracy: number, baselineAccuracy: number): string {
  const delta = (accuracy - baselineAccuracy) * 100;
  return `${delta < 0 ? "-" : "+"}${Math.abs(delta).toFixed(1)}%`;
}

/**
 * True for a "before optimization" headline - by the report's own declared
 * provenance, never inferred from zero deltas (the product owner, 2026-07-30: an
 * optimizer run whose fitted result equals the baseline is a measurement and
 * must not read as "not optimized yet").
 */
export function isBaselineHeadline(headline: TileHeadline): boolean {
  return headline.baseline_only === true;
}

/**
 * The tile's evidence block: the measured axes RELATIVE to the frontier anchor
 * (an absolute per-run dollar figure is arbitrary without the anchor's; the
 * deltas are the product story), or one line naming their absence. Accuracy
 * falls back to its absolute task-success figure when the row carries no
 * baseline (a workspace endpoint whose report predates the paired baseline);
 * the axis definitions live in each page's footnote.
 */
export function TileMetrics({ headline }: { headline: TileHeadline | null }) {
  if (headline === null) {
    return (
      <p className="m-0 flex-1 text-[12px] leading-5 text-ink-faint">
        Quality, cost, and latency {NOT_YET_MEASURED}
      </p>
    );
  }
  if (isBaselineHeadline(headline)) {
    // A "before optimization" report: the endpoint serves its baseline model,
    // so every delta is a true zero. Three 0% rows read as a broken card, not
    // a measurement; say what the state actually is instead.
    return (
      <p className="m-0 flex-1 text-[12px] leading-5 text-ink-faint">
        Serving its baseline model; not optimized yet
      </p>
    );
  }
  const rows = [
    headline.baseline_accuracy !== undefined
      ? {
          label: "accuracy vs frontier",
          value: formatAccuracyDelta(headline.accuracy, headline.baseline_accuracy)
        }
      : { label: "task success", value: `${Math.round(headline.accuracy * 100)}%` },
    { label: "cost saving", value: `${Math.round(headline.savings_fraction * 100)}%` },
    {
      label: "latency saving",
      value:
        headline.latency_savings_fraction === undefined
          ? NOT_YET_MEASURED
          : `${Math.round(headline.latency_savings_fraction * 100)}%`
    }
  ];
  return (
    <div className="flex flex-1 flex-col justify-end">
      {rows.map((row) => (
        <div
          className="flex items-baseline justify-between gap-3 border-t border-line py-1.5 first:border-t-0"
          key={row.label}
        >
          {/* The label yields, the figure never does: a truncated "+1.2…" is a
              broken claim, a truncated label is still legible. */}
          <span className="mono-label min-w-0 truncate" title={row.label}>
            {row.label}
          </span>
          <span
            className={clsx(
              "shrink-0 whitespace-nowrap text-right text-sm",
              row.value === NOT_YET_MEASURED ? "text-ink-faint" : "font-semibold text-ink"
            )}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}
