"use client";

import { ChevronDown, Coins, Database, ShieldAlert, Timer, X } from "lucide-react";
import { useState } from "react";

import { Chip } from "@/components/ui/Chip";
import { EXAMPLE_SUGGESTIONS } from "@/lib/telemetry-demo";
import type { Suggestion, SuggestionKind } from "@/lib/types";

// One icon per suggestion kind; icons accompany the title, never carry the
// meaning alone.
const KIND_ICONS: Record<SuggestionKind, typeof Coins> = {
  cheaper_model: Coins,
  caching: Database,
  latency: Timer,
  quality: ShieldAlert
};

/**
 * "est. $12.40/mo" — savings are estimates from the org's own usage, labeled
 * as such and never clamped: a negative estimate renders honestly.
 */
function savingsLabel(value: string): string {
  return value.startsWith("-") ? `est. −$${value.slice(1)}/mo` : `est. $${value}/mo`;
}

type SuggestionCardProps = {
  suggestion: Suggestion;
  /** Example cards carry the "Example" chip and no dismiss control. */
  example: boolean;
  onDismiss: (id: string) => void;
};

function SuggestionCard({ suggestion, example, onDismiss }: SuggestionCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const Icon = KIND_ICONS[suggestion.kind];
  return (
    <article className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-line bg-surface p-3.5">
      <div className="flex items-start gap-2">
        <Icon aria-hidden className="mt-0.5 shrink-0 text-muted" size={15} strokeWidth={1.8} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[13px] font-semibold leading-snug text-ink">
              {suggestion.title}
            </h3>
            {example && <Chip label="Example" tone="future" />}
          </div>
          {suggestion.estimated_monthly_savings_usd !== null && (
            <p className="m-0 mt-0.5 text-[12px] font-medium tabular-nums text-success">
              {savingsLabel(suggestion.estimated_monthly_savings_usd)}
              <span className="ml-1 font-normal text-muted-2">estimate, not a quote</span>
            </p>
          )}
        </div>
        {!example && (
          <button
            aria-label={`Dismiss suggestion: ${suggestion.title}`}
            className="cursor-pointer rounded bg-transparent p-1 text-muted-2 hover:text-ink"
            onClick={() => onDismiss(suggestion.id)}
            type="button"
          >
            <X aria-hidden size={13} strokeWidth={1.8} />
          </button>
        )}
      </div>
      <p className="m-0 text-[12px] leading-relaxed text-muted">{suggestion.body}</p>
      <div>
        <button
          aria-expanded={evidenceOpen}
          className="flex cursor-pointer items-center gap-1 rounded bg-transparent p-0 text-[11px] font-medium text-muted hover:text-ink"
          onClick={() => setEvidenceOpen((open) => !open)}
          type="button"
        >
          <ChevronDown
            aria-hidden
            className={evidenceOpen ? "rotate-180" : undefined}
            size={12}
            strokeWidth={1.8}
          />
          Why this suggestion
        </button>
        {evidenceOpen && (
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 border-l border-line pl-3">
            {suggestion.evidence.map((line) => (
              <li className="text-[11px] leading-relaxed text-muted" key={line}>
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

type SuggestionsSectionProps = {
  suggestions: Suggestion[];
  /**
   * When true, an empty result falls back to two labeled EXAMPLE cards so the
   * panel explains what it does. The Insights surface passes false: round-2
   * asks suggestions to be tied to REAL usage and show nothing otherwise, so
   * there the empty state is a quiet "nothing yet" line.
   */
  allowExamples?: boolean;
};

/**
 * The Suggestions panel: ways to save money or improve quality, derived from
 * the org's own usage by the interim rules engine (the response shape is the
 * contract the real engine later fills). Dismissal is client-side and lasts
 * for the visit.
 */
export function SuggestionsSection({ suggestions, allowExamples = true }: SuggestionsSectionProps) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const showExamples = allowExamples && suggestions.length === 0;
  const visible = showExamples
    ? EXAMPLE_SUGGESTIONS
    : suggestions.filter((suggestion) => !dismissed.has(suggestion.id));
  const emptyReal = !allowExamples && suggestions.length === 0;

  return (
    <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      <header>
        <h2 className="m-0 text-[13px] font-semibold text-ink">Suggestions</h2>
        <p className="m-0 mt-0.5 text-[11px] text-muted-2">
          Ways to save money or improve quality, read from your own usage. Savings are
          estimates, never invoiced amounts.
          {showExamples && " Nothing stands out yet, so here is what suggestions look like."}
        </p>
      </header>
      {emptyReal ? (
        <p className="m-0 mt-3 text-[12px] text-muted">
          Nothing stands out in your usage yet. Suggestions appear here once there is enough
          traffic to find a cheaper model, a quality issue, or a latency problem.
        </p>
      ) : visible.length === 0 ? (
        <p className="m-0 mt-3 text-[12px] text-muted">
          Suggestions dismissed for this visit. They return on your next one.
        </p>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {visible.map((suggestion) => (
            <SuggestionCard
              example={showExamples}
              key={suggestion.id}
              onDismiss={(id) =>
                setDismissed((current) => new Set([...current, id]))
              }
              suggestion={suggestion}
            />
          ))}
        </div>
      )}
    </section>
  );
}
