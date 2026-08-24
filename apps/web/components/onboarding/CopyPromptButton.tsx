"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

type CopyPromptButtonProps = {
  /** The full prompt text copied to the clipboard. */
  text: string;
};

/** Copy a paste-able onboarding prompt to the clipboard, with a brief confirmation. */
export function CopyPromptButton({ text }: CopyPromptButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-onboard-text text-onboard-bg font-semibold text-sm tracking-tight hover:bg-white transition-colors"
      onClick={() => void copy()}
      type="button"
    >
      {copied ? (
        <Check aria-hidden size={15} strokeWidth={2} />
      ) : (
        <Copy aria-hidden size={15} strokeWidth={1.8} />
      )}
      {copied ? "Copied" : "Copy setup prompt"}
    </button>
  );
}
