import type { ReactNode } from "react";

// The standard docs page opening: group eyebrow, title, one-line lede. Every
// docs page starts with this so the section reads as one publication.

export function DocsPageHeader({
  eyebrow,
  title,
  lede
}: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
}) {
  return (
    <header>
      <p className="mono-label m-0">{eyebrow}</p>
      <h1 className="m-0 mt-2 text-[clamp(24px,3vw,28px)] font-semibold tracking-tight text-ink">
        {title}
      </h1>
      <p className="mb-0 mt-3 max-w-[62ch] text-[14px] leading-relaxed text-muted">{lede}</p>
    </header>
  );
}

/** The pre-launch stub body: content packets replace it page by page. */
export function DocsPlaceholder() {
  return (
    <p className="mt-8 rounded-md border border-line bg-surface px-3.5 py-3 text-[13px] leading-relaxed text-muted">
      This page is part of the launch documentation and its content is landing
      shortly.
    </p>
  );
}
