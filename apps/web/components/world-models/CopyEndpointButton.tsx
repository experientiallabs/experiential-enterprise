"use client";

import { useState, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";

type CopyEndpointButtonProps = {
  /** Ready-to-run curl example for the model's serving endpoint. */
  curl: string;
};

/**
 * Icon-only endpoint copy for a world-model list row. Lives inside the row's
 * link, so the click must not navigate.
 */
export function CopyEndpointButton({ curl }: CopyEndpointButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    await navigator.clipboard.writeText(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      aria-label="Copy endpoint curl example"
      className="grid h-7 w-7 place-items-center rounded-[var(--radius-md)] text-foreground/30 transition-colors hover:bg-background hover:text-foreground"
      onClick={(event) => void copy(event)}
      title={copied ? "Copied" : "Copy endpoint"}
      type="button"
    >
      {copied ? (
        <Check aria-hidden size={15} strokeWidth={2} />
      ) : (
        <Copy aria-hidden size={15} strokeWidth={1.8} />
      )}
    </button>
  );
}
