"use client";

// The model detail page's quickstart: an OpenRouter-style, prompt-first set of
// tabs that get someone calling THIS model through the gateway with the least
// reading. The PROMPT tab comes first — a first-person setup prompt the visitor
// hands to their own agent (same voice as /yc, scoped to this one model); then
// the SDK snippets (Python, JavaScript); then curl as the secondary escape
// hatch. Every tab authenticates with the caller's Experiential API key via the
// EXPLABS_API_KEY env var. When the org has no key yet, a "create an API key"
// CTA sits above the snippet — signed out it opens the login modal, signed in it
// links to the key page — so the reader always has the one next step in view.
// Base-URL resolution stays single-sourced in endpoint-snippets.

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, KeyRound } from "lucide-react";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { Snippet } from "@/components/world-models/endpoint-snippets";
import { SlidingTabs } from "@/components/ui/SlidingTabs";
import { useOrgApiKeys } from "@/components/keys/store";
import { apiKeysPath } from "@/lib/routes";

type QuickstartCardProps = {
  modelSlug: string;
  /** Resolved server-side (publicServingBaseUrl) — hosted host or the stack's. */
  servingBaseUrl: string;
  /** Null while signed out; enables the has-a-key read and the settings link. */
  orgId: string | null;
  /**
   * Serving truth (lib/models-catalog/serving.servedThroughExperiential): true
   * when the model has an active host-managed route, so these snippets run on
   * platform credits. False = BYOK-only: the same gateway call works, but ONLY
   * after the org connects its own provider key, so we say so instead of
   * implying it "just works" on credits.
   */
  servedThroughExperiential: boolean;
};

type TabKey = "prompt" | "python" | "javascript" | "curl";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "prompt", label: "Agent prompt" },
  { key: "python", label: "Python" },
  { key: "javascript", label: "JavaScript" },
  { key: "curl", label: "cURL" }
];

export function QuickstartCard({
  modelSlug,
  servingBaseUrl,
  orgId,
  servedThroughExperiential
}: QuickstartCardProps) {
  const { open } = useLoginModal();
  const [tab, setTab] = useState<TabKey>("prompt");
  const [copied, setCopied] = useState(false);
  // total > 0 means the org already has at least one API key to authenticate
  // with; signed out we cannot read keys, so the CTA always shows.
  const keysRead = useOrgApiKeys(orgId, 1, false);
  const hasKey = (keysRead.data?.total ?? 0) > 0;

  const text = snippetFor(tab, modelSlug, servingBaseUrl);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    // Compact by design (the product owner r4: visibly shorter): tight paddings, no
    // per-tab explainer, and the snippet scrolls inside a capped frame instead
    // of stretching the page.
    <section
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3.5"
      data-testid="quickstart-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono-label m-0">Quickstart</p>
        <SlidingTabs
          activeKey={tab}
          ariaLabel="Quickstart tab"
          onPick={(key) => setTab(key as TabKey)}
          tabs={TABS}
        />
      </div>

      {!servedThroughExperiential ? (
        <p
          className="m-0 rounded-md border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-[12.5px] leading-relaxed text-warning"
          data-testid="quickstart-byok-notice"
        >
          This model isn&apos;t hosted on Experiential credits. The gateway call below works only
          after you connect your own provider key for it, add one under &quot;Ways to use&quot;.
        </p>
      ) : null}

      {!hasKey ? (
        orgId === null ? (
          <button
            className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-[12.5px] font-semibold text-accent transition-colors hover:bg-accent-soft/70"
            onClick={open}
            type="button"
          >
            <KeyRound aria-hidden size={13} strokeWidth={1.8} />
            Click to create an API key
          </button>
        ) : (
          <Link
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-[12.5px] font-semibold text-accent transition-colors hover:bg-accent-soft/70"
            href={apiKeysPath()}
          >
            <KeyRound aria-hidden size={13} strokeWidth={1.8} />
            Click to create an API key
          </Link>
        )
      ) : null}

      <div className="relative max-h-44 overflow-y-auto rounded-md" data-testid="quickstart-snippet-frame">
        <Snippet text={text} wrap={tab === "prompt"} />
        <button
          aria-label="Copy snippet"
          className="absolute right-2 top-2 inline-flex cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-[10.5px] text-ink-soft transition-colors hover:text-ink"
          onClick={copy}
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
        {tab === "prompt"
          ? "Set EXPLABS_API_KEY to an organization API key before running your agent."
          : "Reads your organization API key from the EXPLABS_API_KEY environment variable."}
      </p>
    </section>
  );
}

/** The snippet text for one tab; base-URL comes resolved from the server. */
function snippetFor(tab: TabKey, model: string, baseUrl: string): string {
  switch (tab) {
    case "prompt":
      return agentPrompt(model, baseUrl);
    case "python":
      return pythonSnippet(model, baseUrl);
    case "javascript":
      return javascriptSnippet(model, baseUrl);
    case "curl":
      return curlSnippet(model, baseUrl);
  }
}

/** First-person agent setup prompt, scoped to calling this model via the gateway. */
function agentPrompt(model: string, baseUrl: string): string {
  return [
    `I want you to route my LLM calls for "${model}" through the Experiential gateway instead of`,
    "calling the provider directly. It speaks the OpenAI Chat Completions API, so this is a base-URL",
    "and key swap. Please:",
    "",
    `1. Point the client at ${baseUrl}/v1 as the base URL.`,
    "2. Authenticate with my Experiential API key from the EXPLABS_API_KEY environment variable. If",
    "   it isn't set, stop and tell me to create one under Settings -> API keys and export it.",
    `3. Use the model id "${model}" exactly.`,
    "4. Update every place my code builds an LLM client for this model to use that base URL and key,",
    "   leaving streaming and tool-calls as they are.",
    "5. Make one test call and show me the reply plus the token usage, so we confirm it runs on my",
    "   Experiential credits.",
    "",
    "Tell me which files you changed."
  ].join("\n");
}

function pythonSnippet(model: string, baseUrl: string): string {
  return [
    "import os",
    "",
    "from openai import OpenAI",
    "",
    `client = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["EXPLABS_API_KEY"])`,
    "response = client.chat.completions.create(",
    `    model="${model}",`,
    '    messages=[{"role": "user", "content": "Hello from my product"}],',
    ")",
    "print(response.choices[0].message.content)"
  ].join("\n");
}

function javascriptSnippet(model: string, baseUrl: string): string {
  return [
    'import OpenAI from "openai";',
    "",
    "const client = new OpenAI({",
    `  baseURL: "${baseUrl}/v1",`,
    "  apiKey: process.env.EXPLABS_API_KEY",
    "});",
    "",
    "const response = await client.chat.completions.create({",
    `  model: "${model}",`,
    '  messages: [{ role: "user", content: "Hello from my product" }]',
    "});",
    "console.log(response.choices[0].message.content);"
  ].join("\n");
}

function curlSnippet(model: string, baseUrl: string): string {
  return [
    `curl "${baseUrl}/v1/chat/completions" \\`,
    '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello from my product"}]}'`
  ].join("\n");
}
