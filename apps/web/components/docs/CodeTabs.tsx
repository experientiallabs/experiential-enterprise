"use client";

import { clsx } from "clsx";
import { Check, Copy } from "lucide-react";
import { Highlight } from "prism-react-renderer";
import { useEffect, useState } from "react";

import {
  CODE_LANGUAGES,
  useCodeLanguage,
  type CodeLanguage
} from "@/components/docs/code-language";

// The docs code block: curl / Python / JavaScript tabs with a per-pane copy
// button. The active language comes from the page-wide CodeLanguageProvider.
// Token colors are CSS-variable-driven (docs.css targets the emitted .token
// classes), so highlighting follows the docs theme; an empty prism theme
// keeps prism-react-renderer from writing inline colors that would not.

const EMPTY_PRISM_THEME = { plain: {}, styles: [] };

// Prism grammar per tab; curl is shell.
const PRISM_LANGUAGE: Record<CodeLanguage, string> = {
  curl: "bash",
  python: "python",
  javascript: "javascript"
};

const COPIED_FLASH_MS = 1600;

export type CodeTabsProps = {
  /** One snippet per language; all three are required so tabs never dead-end. */
  snippets: Record<CodeLanguage, string>;
  /** Optional label in the tab bar (e.g. the endpoint the block calls). */
  title?: string;
};

export function CodeTabs({ snippets, title }: CodeTabsProps) {
  const { language, setLanguage } = useCodeLanguage();
  const [copied, setCopied] = useState(false);
  const code = snippets[language].trimEnd();

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard unavailable (permission denied, insecure context): don't
      // flash a false "Copied", and don't leak an unhandled rejection.
      return;
    }
    setCopied(true);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-1 border-b border-line bg-surface-subtle px-2">
        {CODE_LANGUAGES.map((option) => (
          <button
            key={option.id}
            className={clsx(
              "-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-2.5 py-2 font-mono text-[11.5px]",
              option.id === language
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink"
            )}
            onClick={() => setLanguage(option.id)}
            type="button"
            aria-pressed={option.id === language}
          >
            {option.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {title && <span className="mono-label">{title}</span>}
          <button
            className="flex cursor-pointer items-center gap-1 border-0 bg-transparent px-1.5 py-2 text-[11px] font-medium text-muted hover:text-ink"
            onClick={copy}
            type="button"
            aria-label={copied ? "Copied" : "Copy code"}
          >
            {copied ? <Check size={13} strokeWidth={1.8} className="text-accent" /> : <Copy size={13} strokeWidth={1.8} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <Highlight code={code} language={PRISM_LANGUAGE[language]} theme={EMPTY_PRISM_THEME}>
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
