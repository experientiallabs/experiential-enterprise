"use client";

import Link from "next/link";

import { PlaygroundLink } from "@/components/playground/PlaygroundLink";
import { buttonClassName } from "@/components/ui/Button";
import { CopyEndpointButton } from "@/components/world-models/CopyEndpointButton";
import { chatCompletionsSnippets, Snippet } from "@/components/world-models/endpoint-snippets";
import { modelsPath } from "@/lib/routes";

type FirstCallSectionProps = {
  /**
   * The model the never-used state offers as the first call (resolved
   * server-side: a serving Project when one exists). Null means the org has
   * no model to call, so the state offers the create door instead.
   */
  firstCall: { modelName: string; baseUrl: string } | null;
};

/**
 * The nav entry does not wait for traffic, so this is many members' first
 * sight of Telemetry. The page keeps its full outline (tiles, chart, tables
 * read as zero); this section is the actionable part: the exact call that
 * produces a first request, copyable, or the create door when there is no
 * model to call. The host page's gentle poll swaps to live data on its own
 * once one lands.
 */
export function FirstCallSection({ firstCall }: FirstCallSectionProps) {
  if (firstCall === null) {
    return (
      <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-[13px] font-semibold text-ink">No usage yet</h2>
            <p className="m-0 mt-1 max-w-[640px] text-[12.5px] leading-relaxed text-muted">
              Every request through the gateway lands here as it happens. There is no model to
              call yet - create one and its OpenAI-compatible URL appears on its page.
            </p>
          </div>
          <Link className={buttonClassName("accent", undefined, "sm")} href={modelsPath()}>
            Create a model
          </Link>
        </div>
      </section>
    );
  }
  const curl = chatCompletionsSnippets(firstCall.modelName, firstCall.baseUrl).curl;
  return (
    <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-[13px] font-semibold text-ink">No usage yet</h2>
          <p className="m-0 mt-1 max-w-[640px] text-[12.5px] leading-relaxed text-muted">
            Every request through the gateway lands here as it happens. Send{" "}
            <span className="font-mono">{firstCall.modelName}</span> its first one - copy the
            call below, or try it from the playground.
          </p>
        </div>
        <PlaygroundLink modelName={firstCall.modelName} />
      </div>
      <div className="relative mt-3">
        <Snippet text={curl} />
        <div className="absolute right-1.5 top-1.5">
          <CopyEndpointButton curl={curl} />
        </div>
      </div>
    </section>
  );
}
