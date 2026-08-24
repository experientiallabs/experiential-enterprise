"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";

import { SuggestionsSection } from "@/components/telemetry-page/suggestions-panel";
import { buttonClassName } from "@/components/ui/Button";
import type { Suggestion } from "@/lib/types";

type InsightsSuggestionsProps = {
  orgId: string;
  /** The rule-based suggestions computed at page load — the always-on baseline. */
  suggestions: Suggestion[];
};

/**
 * The Insights suggestions column: the deterministic rule results render
 * immediately, and "Deep analysis" runs the on-demand advice agent — an LLM
 * exploring the org's own content-free usage aggregates server-side — merging
 * its findings (id-deduplicated) into the same panel. A deployment without a
 * platform LLM credential answers 503; the button surfaces that message
 * honestly instead of pretending to analyze.
 */
export function InsightsSuggestions({ orgId, suggestions }: InsightsSuggestionsProps) {
  const [agentSuggestions, setAgentSuggestions] = useState<Suggestion[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDeepAnalysis() {
    if (running) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`/api/orgs/${orgId}/insights/agent-advice?window=7d`, {
        method: "POST",
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => null)) as {
        suggestions?: Suggestion[];
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Deep analysis failed (${response.status})`);
      }
      setAgentSuggestions(payload?.suggestions ?? []);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "Deep analysis failed");
    } finally {
      setRunning(false);
    }
  }

  const baseIds = new Set(suggestions.map((suggestion) => suggestion.id));
  const merged =
    agentSuggestions === null
      ? suggestions
      : [...suggestions, ...agentSuggestions.filter((suggestion) => !baseIds.has(suggestion.id))];

  return (
    <div className="flex flex-col gap-2">
      <SuggestionsSection allowExamples={false} suggestions={merged} />
      <div className="flex flex-col gap-1">
        <button
          className={buttonClassName("default", undefined, "sm")}
          disabled={running}
          onClick={() => void runDeepAnalysis()}
          type="button"
        >
          <Sparkles aria-hidden size={13} strokeWidth={1.8} />
          {running ? "Analyzing your usage…" : "Deep analysis"}
        </button>
        {agentSuggestions !== null && agentSuggestions.length === 0 && error === null && (
          <p className="m-0 text-[11px] text-muted-2">
            The agent found nothing beyond the suggestions above.
          </p>
        )}
        {error !== null && <p className="m-0 text-[11px] text-danger">{error}</p>}
      </div>
    </div>
  );
}
