"use client";

// "Call it now": the copyable Chat Completions call for this model — curl and
// Python behind a small selector, with the org-key placeholder. Snippet text
// comes from the shared endpoint-snippets module so the base-URL resolution
// and shell escaping stay single-sourced.

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { SlidingTabs } from "@/components/ui/SlidingTabs";
import {
  chatCompletionsSnippets,
  Snippet
} from "@/components/world-models/endpoint-snippets";

type CallSnippetCardProps = {
  modelSlug: string;
  /** Resolved server-side (publicServingBaseUrl) — hosted host or the stack's. */
  servingBaseUrl: string;
  /** Renders the "model created" success framing (the /models/new landing). */
  justCreated?: boolean;
};

export function CallSnippetCard({
  modelSlug,
  servingBaseUrl,
  justCreated = false
}: CallSnippetCardProps) {
  const [tab, setTab] = useState<"curl" | "python">("curl");
  const [copied, setCopied] = useState(false);
  const snippets = chatCompletionsSnippets(modelSlug, servingBaseUrl);
  const text = tab === "curl" ? snippets.curl : snippets.python;

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]"
      data-testid="call-snippet-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono-label m-0">{justCreated ? "Call it now" : "Call this model"}</p>
        <SlidingTabs
          activeKey={tab}
          ariaLabel="Snippet language"
          onPick={(key) => setTab(key as "curl" | "python")}
          tabs={[
            { key: "curl", label: "cURL" },
            { key: "python", label: "Python" }
          ]}
        />
      </div>
      {justCreated ? (
        <p className="m-0 text-[13px] leading-relaxed text-success">
          Your model is live. It serves through the same gateway endpoint as every other model and
          is visible only to your organization.
        </p>
      ) : null}
      <div className="relative">
        <Snippet text={text} />
        <button
          aria-label="Copy snippet"
          className="absolute right-2 top-2 inline-flex cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-[10.5px] text-ink-soft transition-colors hover:text-ink"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          type="button"
        >
          {copied ? (
            <Check aria-hidden size={11} strokeWidth={2} />
          ) : (
            <Copy aria-hidden size={11} strokeWidth={1.8} />
          )}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <p className="m-0 font-mono text-[11px] text-ink-faint">
        Replace $EXPLABS_API_KEY with an organization API key (Settings → API keys).
      </p>
    </section>
  );
}
