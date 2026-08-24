import { clsx } from "clsx";

export type ChipTone =
  // Verdict / lifecycle statuses
  | "passed"
  | "failed"
  | "invalid"
  | "complete"
  | "cancelled"
  | "running"
  | "queued"
  | "backlog"
  // Session / event statuses
  | "error"
  | "accepted"
  | "rejected"
  | "completed"
  | "opened"
  | "no_changes_needed"
  | "future"
  // Provider-key statuses (lib/format.ts maps the connection enum here)
  | "rate_limited";

type ChipProps = {
  label: string;
  tone?: ChipTone;
};

type SkeletonChipProps = {
  className?: string;
};

// "complete" is deliberately blue (finished or answered) rather than green,
// because it does not imply improvement. "invalid" is amber: the simulation
// was not a valid measurement.
const toneStyles: Record<ChipTone, string> = {
  passed: "bg-success-soft text-success",
  accepted: "bg-success-soft text-success",
  completed: "bg-success-soft text-success",
  opened: "bg-success-soft text-success",
  no_changes_needed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  rejected: "bg-danger-soft text-danger",
  error: "bg-danger-soft text-danger",
  invalid: "bg-warning-soft text-warning",
  complete: "bg-blue-50 text-blue-700",
  running: "bg-surface-subtle text-ink-faint animate-chip-pulse",
  queued: "bg-background text-muted-2",
  cancelled: "bg-line text-muted",
  future: "bg-purple-soft text-purple",
  backlog: "bg-purple-soft text-purple",
  // Amber: the key works but the provider is throttling it right now.
  rate_limited: "bg-warning-soft text-warning",
};

export function Chip({ label, tone = "running" }: ChipProps) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-[9px] py-[5px] font-mono text-[11px] font-semibold uppercase", toneStyles[tone])}>
      {label}
    </span>
  );
}

export function SkeletonChip({ className }: SkeletonChipProps) {
  return (
    <span
      aria-hidden
      className={clsx(
        "skeleton-chip inline-flex h-[23px] w-20 shrink-0 rounded-full bg-gradient-to-r from-surface-subtle via-foreground/[0.06] to-surface-subtle bg-[length:400%_100%] animate-skeleton",
        className
      )}
    />
  );
}
