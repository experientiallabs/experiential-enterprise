import { clsx } from "clsx";

/**
 * The house stat tile: mono-label eyebrow, tabular value, optional detail
 * line. One implementation for every summary strip (Telemetry overview, the
 * serving view, the usage page) so stat blocks read identically everywhere.
 *
 * Spans with block classes throughout: callers wrap tiles in a <button> to
 * make one clickable (the errors tile), and button content must be phrasing
 * content only. `bare` drops the border for exactly that case, where the
 * button carries the frame.
 */
export function StatTile({
  label,
  value,
  detail,
  tone,
  bare = false,
  className
}: {
  label: string;
  value: string;
  /** Small annotation under the value — caveats, splits, sample sizes. */
  detail?: string;
  tone?: "danger";
  bare?: boolean;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "flex min-w-0 flex-col gap-0.5 px-3 py-2",
        !bare && "rounded-[var(--radius-md)] border border-line bg-surface",
        className
      )}
    >
      <span className="mono-label">{label}</span>
      <span
        className={clsx(
          "block text-[15px] font-semibold tabular-nums",
          tone === "danger" ? "text-danger" : "text-ink"
        )}
      >
        {value}
      </span>
      {detail !== undefined && <span className="block text-[11px] text-muted">{detail}</span>}
    </span>
  );
}
