import { PromptCaptureCard } from "@/components/settings/PromptCaptureCard";
import type { Suggestion, UsageByKey, UsageByPrompt, UsageTimeseries } from "@/lib/types";

import { InsightCards } from "./insight-cards";
import { InsightsSuggestions } from "./insights-suggestions";
import { NlQuery } from "./nl-query";

type InsightsViewProps = {
  orgId: string;
  timeseries: UsageTimeseries;
  byKey: UsageByKey;
  byPrompt: UsageByPrompt;
  suggestions: Suggestion[];
  /** Whether the viewer may flip the org-wide prompt-capture opt-in. */
  canManagePromptCapture: boolean;
};

/**
 * The Insights body: your observability over the gateway. The natural-language
 * query box leads; below it, real usage-tied cards on the left and the
 * usage-derived suggestions on the right. Everything is sourced from the org's
 * OWN usage — suggestions show nothing when there is nothing (allowExamples is
 * off here, unlike Telemetry).
 *
 * Two privacy tiers, made legible right where the benefit shows: the grouping
 * insights (Repeated prompts, the caching workflow) ride content-free lineage
 * digests and are always on — no prompt is ever stored for them. The
 * PromptCaptureCard below is the org-wide OPT-IN to also store content, the
 * same setting as Settings → Observability; content-based insights only ever
 * read data captured under it.
 */
export function InsightsView({
  orgId,
  timeseries,
  byKey,
  byPrompt,
  suggestions,
  canManagePromptCapture
}: InsightsViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <NlQuery orgId={orgId} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          <InsightCards byKey={byKey} byPrompt={byPrompt} timeseries={timeseries} />
          <PromptCaptureCard canManage={canManagePromptCapture} orgId={orgId} />
        </div>
        <div className="flex flex-col gap-4">
          <InsightsSuggestions orgId={orgId} suggestions={suggestions} />
        </div>
      </div>
    </div>
  );
}
