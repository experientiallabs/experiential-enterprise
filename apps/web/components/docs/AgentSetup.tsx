"use client";

import { clsx } from "clsx";
import { useId, useState, type ReactNode } from "react";

import { CodeBlock } from "@/components/docs/CodeBlock";

// Per-agent setup on /docs/coding-agents: the paste-able prompt FIRST, the
// manual configuration behind a second tab. Most readers want the agent to
// wire itself; the config is what you read when you'd rather do it by hand or
// need to know exactly what the prompt will change. Tab state is per-section
// (not shared like CodeTabs' language preference): a reader following the
// prompt for one agent may still want the manual fields for another.

export type AgentSetupProps = {
  /** The agent's paste-able prompt, rendered in the default tab. */
  prompt: string;
  /** Label under the prompt block (defaults to a generic instruction). */
  promptHint?: ReactNode;
  /** The hand-configuration steps and snippets. */
  children: ReactNode;
};

const TABS = [
  { id: "prompt", label: "Prompt" },
  { id: "manual", label: "Manual setup" }
] as const;

type TabId = (typeof TABS)[number]["id"];

export function AgentSetup({ prompt, promptHint, children }: AgentSetupProps) {
  const [active, setActive] = useState<TabId>("prompt");
  const base = useId();

  return (
    <div className="my-4">
      <div role="tablist" className="mb-3 flex items-center gap-1 border-b border-line">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            id={`${base}-${tab.id}-tab`}
            aria-selected={tab.id === active}
            aria-controls={`${base}-${tab.id}-panel`}
            className={clsx(
              "-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-3 py-2 text-[12.5px] font-medium",
              tab.id === active
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink"
            )}
            onClick={() => setActive(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${base}-prompt-panel`}
        aria-labelledby={`${base}-prompt-tab`}
        hidden={active !== "prompt"}
      >
        <p className="mb-3 mt-0 text-[13.5px] leading-relaxed text-muted">
          {promptHint ?? "Paste this into the agent. It wires itself up, then proves the key works."}
        </p>
        <CodeBlock code={prompt} language="markdown" title="prompt" />
      </div>
      <div
        role="tabpanel"
        id={`${base}-manual-panel`}
        aria-labelledby={`${base}-manual-tab`}
        hidden={active !== "manual"}
      >
        {children}
      </div>
    </div>
  );
}
