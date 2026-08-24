"use client";

import { clsx } from "clsx";
import { Highlight, themes } from "prism-react-renderer";
import { useState } from "react";

// Clamp bounds for long payloads: serving requests routinely carry
// multi-kilobyte chat bodies, and an un-clamped feed makes scanning
// impossible. Bodies are stored whole; these are render-time bounds only.
const TEXT_CLAMP_CHARS = 700;

// Above this, prism tokenization stalls the main thread on every expand, so
// oversized JSON renders as plain preformatted text instead.
const JSON_HIGHLIGHT_CHARS = 20_000;

export function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const code = JSON.stringify(value, null, 2) ?? "null";
  if (code.length > JSON_HIGHLIGHT_CHARS) {
    return <TextBlock label={label} text={code} />;
  }
  return (
    <div className="mt-2">
      <p className="m-0 mb-1 text-muted-2 text-[10px] font-semibold uppercase tracking-wide">
        {label}
      </p>
      <Highlight code={code} language="json" theme={themes.github}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="m-0 max-h-[360px] overflow-auto rounded-md border border-line bg-surface-subtle px-3 py-2 font-mono text-[12px] leading-relaxed">
            {tokens.map((line, index) => (
              <div key={index} {...getLineProps({ line })}>
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

export function TextBlock({
  label,
  text,
  isError = false
}: {
  label: string;
  text: string;
  isError?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const clamped = !expanded && text.length > TEXT_CLAMP_CHARS;
  const shown = clamped ? `${text.slice(0, TEXT_CLAMP_CHARS)}…` : text;
  return (
    <div className="mt-2">
      <p className="m-0 mb-1 text-muted-2 text-[10px] font-semibold uppercase tracking-wide">
        {label}
      </p>
      <pre
        className={clsx(
          "m-0 whitespace-pre-wrap break-words rounded-md border px-3 py-2 font-mono text-[12px] leading-relaxed",
          isError ? "border-danger bg-danger-soft text-danger" : "border-line bg-surface-subtle text-ink"
        )}
      >
        {shown}
      </pre>
      {text.length > TEXT_CLAMP_CHARS && (
        <button
          className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium text-muted hover:text-ink"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
        </button>
      )}
    </div>
  );
}
