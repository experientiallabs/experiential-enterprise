"use client";

import { clsx } from "clsx";
import { CornerDownLeft, Search, Sparkles } from "lucide-react";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/Button";
import { formatTokens } from "@/lib/format";
import { formatCostUsd } from "@/lib/money";
import type { InsightAnswer, InsightUnit } from "@/lib/types";

// The starter questions the box advertises. They mirror the backend's
// SUPPORTED_QUESTIONS (explabs/api/insights_query.py) so a click always parses.
const EXAMPLE_QUESTIONS = [
  "Which model cost me the most last week?",
  "Show my spend by provider this month",
  "What's my error rate by model?",
  "Which agent made the most requests?"
] as const;

/** Format one answer value in its declared unit. */
function formatValue(value: number, unit: InsightUnit | null): string {
  switch (unit) {
    case "usd":
      return formatCostUsd(value);
    case "percent":
      return `${value.toFixed(1)}%`;
    case "count":
      return formatTokens(value);
    case null:
      return String(value);
  }
}

/** The largest value in the answer, for the row bars (0 when all-zero). */
function maxValue(answer: InsightAnswer): number {
  return answer.rows.reduce((peak, row) => Math.max(peak, row.value), 0);
}

type NlQueryProps = {
  orgId: string;
};

/**
 * The natural-language query box: ask a plain-language question about your own
 * usage and get a ranked, sourced answer. The question is classified and
 * answered server-side over the org's usage aggregates — read-only, org-scoped,
 * no free-form SQL — so the box only ever POSTs the question string.
 */
export function NlQuery({ orgId }: NlQueryProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<InsightAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(raw: string) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/orgs/${orgId}/insights/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Query failed (${response.status})`);
      }
      setAnswer((await response.json()) as InsightAnswer);
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : "Query failed");
      setAnswer(null);
    } finally {
      setLoading(false);
    }
  }

  function runExample(example: string) {
    setQuestion(example);
    void ask(example);
  }

  const peak = answer ? maxValue(answer) : 0;

  return (
    <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      <header className="flex items-center gap-2">
        <Sparkles aria-hidden className="text-accent" size={15} strokeWidth={1.8} />
        <h2 className="m-0 text-[13px] font-semibold text-ink">Ask your usage</h2>
      </header>
      <p className="m-0 mt-0.5 text-[11px] text-muted-2">
        Ask a plain-language question about your own gateway usage. Answers read your usage
        aggregates directly, no request bodies, nothing leaves your org.
      </p>

      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <div className="flex flex-1 items-center gap-2 rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-accent">
          <Search aria-hidden className="shrink-0 text-muted-2" size={14} strokeWidth={1.8} />
          <input
            aria-label="Ask a question about your usage"
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-muted-2"
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Which model cost me the most last week?"
            value={question}
          />
        </div>
        <button
          className={clsx(buttonClassName("primary", undefined, "sm"), "gap-1.5")}
          disabled={loading || question.trim().length === 0}
          type="submit"
        >
          {loading ? "Asking…" : "Ask"}
          <CornerDownLeft aria-hidden size={12} strokeWidth={1.8} />
        </button>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLE_QUESTIONS.map((example) => (
          <button
            className="cursor-pointer rounded-full border border-line bg-surface-subtle px-2.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
            disabled={loading}
            key={example}
            onClick={() => runExample(example)}
            type="button"
          >
            {example}
          </button>
        ))}
      </div>

      {error !== null && (
        <p className="m-0 mt-3 text-[12px] text-danger">{error}</p>
      )}

      {answer !== null && error === null && (
        <div className="mt-3 rounded-[var(--radius-md)] border border-line bg-surface-subtle p-3.5">
          {answer.understood && answer.interpretation.length > 0 && (
            <p className="mono-label m-0">{answer.interpretation}</p>
          )}
          <p className="m-0 mt-1 text-[13px] font-medium leading-snug text-ink">
            {answer.headline}
          </p>

          {answer.rows.length > 0 && (
            <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0">
              {answer.rows.slice(0, 8).map((row) => (
                <li className="flex flex-col gap-1" key={row.label}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[12px] text-ink">{row.label}</span>
                    <span className="shrink-0 text-[12px] font-medium tabular-nums text-ink">
                      {formatValue(row.value, answer.unit)}
                      {row.detail !== null && (
                        <span className="ml-1.5 font-normal text-muted-2">{row.detail}</span>
                      )}
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${peak > 0 ? (row.value / peak) * 100 : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {answer.caveat !== null && (
            <p className="m-0 mt-2.5 text-[11px] text-muted-2">{answer.caveat}</p>
          )}

          {!answer.understood && answer.examples.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {answer.examples.map((example) => (
                <button
                  className="cursor-pointer rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-ink"
                  key={example}
                  onClick={() => runExample(example)}
                  type="button"
                >
                  {example}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
