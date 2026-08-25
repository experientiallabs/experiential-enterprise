import { formatCostUsd } from "@/lib/money";
import type { ImportedUsage, ImportSource } from "@/lib/types";

const SOURCE_LABELS: Record<ImportSource, string> = {
  codex: "Codex",
  "claude-code": "Claude Code"
};

function sourceLabel(source: ImportSource): string {
  return SOURCE_LABELS[source] ?? source;
}

type ImportedSpendSectionProps = {
  imported: ImportedUsage;
};

/**
 * Imported historical spend, aggregated per (source, model). Attribution only:
 * spend the tenant already paid their provider (imported from local Codex /
 * Claude Code logs by the onboarding step-5 import), shown so the usage view is
 * complete from day one. It is never charged here and never deducted from
 * credits. Renders nothing when there is no imported usage, so the section
 * stays out of the way for orgs that never ran an import.
 */
export function ImportedSpendSection({ imported }: ImportedSpendSectionProps) {
  if (imported.models.length === 0) {
    return null;
  }
  return (
    <section className="shrink-0 rounded-[var(--radius-lg)] border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-2.5">
        <h2 className="m-0 text-[13px] font-semibold text-ink">Imported historical spend</h2>
        <span className="text-[11px] text-muted-2">
          Already-paid provider spend, imported for your records, never charged here.
        </span>
        <span className="ml-auto tabular-nums text-[12px] font-medium text-ink">
          {formatCostUsd(imported.totals.cost_usd)}
        </span>
      </header>
      <div className="max-h-[40vh] overflow-auto p-3.5">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted-2">
              <th className="px-2 py-2 font-semibold">Source</th>
              <th className="px-2 py-2 font-semibold">Model</th>
              <th className="px-2 py-2 text-right font-semibold">Requests</th>
              <th className="px-2 py-2 text-right font-semibold">Tokens in/out</th>
              <th className="px-2 py-2 text-right font-semibold">Spend</th>
            </tr>
          </thead>
          <tbody>
            {imported.models.map((row) => (
              <tr key={`${row.source}:${row.model}`} className="border-b border-line">
                <td className="whitespace-nowrap px-2 py-2 text-muted">{sourceLabel(row.source)}</td>
                <td className="whitespace-nowrap px-2 py-2 font-medium text-ink">
                  {row.model}
                  {!row.model_matched && (
                    <span className="ml-1.5 text-[10px] font-normal text-muted-2">unmatched</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted">
                  {row.request_count.toLocaleString()}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums text-muted">
                  {row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-ink">
                  {formatCostUsd(row.cost_usd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
