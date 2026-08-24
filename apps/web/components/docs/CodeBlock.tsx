"use client";

import { Check, Copy } from "lucide-react";
import { Highlight } from "prism-react-renderer";
import { useEffect, useState } from "react";

// The single-snippet sibling of CodeTabs, for code that exists in exactly one
// language (a TOML or JSON config file, a shell export). No tab bar and no
// CodeLanguageProvider coupling: the language is a property of the artifact,
// not a reader preference. Same docs-code token styling and copy affordance
// as CodeTabs so the two read as one system.

const EMPTY_PRISM_THEME = { plain: {}, styles: [] };

const COPIED_FLASH_MS = 1600;

export type CodeBlockProps = {
  code: string;
  /** Prism grammar id (e.g. "bash", "json", "toml"). Unknown ids render unhighlighted. */
  language: string;
  /** Label in the header bar (e.g. the config file's path). */
  title?: string;
};

export function CodeBlock({ code, language, title }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const trimmed = code.trimEnd();

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(trimmed);
    } catch {
      // Clipboard unavailable (permission denied, insecure context): don't
      // flash a false "Copied", and don't leak an unhandled rejection.
      return;
    }
    setCopied(true);
  };

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line bg-surface-subtle px-3">
        <span className="mono-label">{title ?? language}</span>
        <button
          className="ml-auto flex cursor-pointer items-center gap-1 border-0 bg-transparent px-1.5 py-2 text-[11px] font-medium text-muted hover:text-ink"
          onClick={copy}
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? (
            <Check size={13} strokeWidth={1.8} className="text-accent" />
          ) : (
            <Copy size={13} strokeWidth={1.8} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <Highlight code={trimmed} language={language} theme={EMPTY_PRISM_THEME}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="docs-code m-0 overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-ink">
            {tokens.map((line, lineIndex) => (
              <div key={lineIndex} {...getLineProps({ line })}>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
