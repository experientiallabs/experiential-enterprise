"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, Copy } from "lucide-react";

import { ConfettiBurst } from "@/components/auth/ConfettiBurst";
import {
  buildByokConnectPrompt,
  buildFirstCallPrompt
} from "@/components/auth/welcome-prompts";
import { buildTraceTelemetryPrompt } from "@/components/trace-onboarding/setup-prompt";
import { YCombinatorMark } from "@/components/yc/YCombinatorMark";
import { formatGrantUsd } from "@/lib/money";
import { docsPath } from "@/lib/routes";

/**
 * The welcome celebration modal body — the ONE shared surface behind both the
 * first-key reveal (LoginModal success step) and the admin re-triggerable
 * celebration (components/shell/WelcomeTrigger). Deliberately MINIMAL: confetti,
 * the announced credit amount, the copy-paste onboarding prompts, and two quick
 * links (Docs + the machine-readable llms.txt). The API-key block shows only
 * when a usable secret is available AND the caller opts in (`showApiKey`), so a
 * re-trigger for an org that already holds keys degrades to the prompts alone
 * rather than surfacing a key it cannot reveal.
 */
export function WelcomeCelebration({
  grantedUsd,
  apiKey,
  showApiKey,
  webBaseUrl,
  apiBaseUrl,
  creditCaption = "in credits applied",
  variant,
  onClose
}: {
  /** The credit figure to announce, or null to omit the credits line. */
  grantedUsd: number | null;
  /** A usable `xpl_` secret to display+embed, or null when none is available. */
  apiKey: string | null;
  /** Whether to surface the API key (admin toggle; always true on first mint). */
  showApiKey: boolean;
  webBaseUrl: string;
  apiBaseUrl: string;
  /** Sub-line under the amount; the first-key reveal frames it as free start credit. */
  creditCaption?: string;
  /**
   * Custom-path branding seam: "yc" co-brands the modal (Y Combinator mark +
   * "Your YC deal is applied" headline) for founders who came through the YC
   * onboarding path. Undefined = the default look.
   */
  variant?: "yc";
  onClose: () => void;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const keyToShow = showApiKey ? apiKey : null;
  // Embed the key into the prompts only when we actually surface it; otherwise
  // the prompts carry their own fill-in slot.
  const promptKey = keyToShow;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-6"
      data-testid="login-modal"
      onClick={onClose}
    >
      <section
        aria-modal="true"
        className="relative max-h-[90dvh] w-full max-w-[min(680px,92vw)] overflow-y-auto rounded-[var(--radius-lg)] border border-line bg-surface p-9 shadow-[0_18px_50px_rgba(20,20,18,0.14)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex flex-col gap-6" data-testid="login-success-step">
          <ConfettiBurst />

          {variant === "yc" && (
            <div className="flex justify-center" data-testid="welcome-yc-mark">
              <YCombinatorMark className="h-8 w-8 rounded-md" />
            </div>
          )}

          {grantedUsd !== null && (
            <div
              className="flex flex-col items-center gap-1 py-2 text-center"
              data-testid="welcome-credits-line"
            >
              {variant === "yc" ? (
                <span className="text-[15px] font-medium text-ink">
                  Your YC deal is applied 🎉
                </span>
              ) : (
                <span className="mono-label text-accent">Welcome, you're in</span>
              )}
              <span className="text-[clamp(48px,12vw,72px)] font-semibold leading-none tracking-tight text-ink">
                {formatGrantUsd(grantedUsd)}
              </span>
              <span className="text-[15px] font-medium text-muted">{creditCaption}</span>
            </div>
          )}

          {keyToShow !== null && (
            <div>
              <span className="mono-label">API key</span>
              <div className="mt-2 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line bg-background px-3 py-2.5">
                <code className="overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink no-scrollbar">
                  {keyToShow}
                </code>
                <CopyButton value={keyToShow} label="Copy API key" />
              </div>
              <p className="m-0 mt-1.5 text-[13px] font-medium text-muted">
                This key won&apos;t be shown again. Copy it now.
              </p>
            </div>
          )}

          <WelcomePrompts apiKey={promptKey} webBaseUrl={webBaseUrl} apiBaseUrl={apiBaseUrl} />

          <div className="flex items-center justify-between border-t border-line pt-4 text-[13px]">
            <Link
              className="inline-flex items-center gap-1 text-muted transition-colors hover:text-ink"
              href={docsPath()}
              onClick={onClose}
            >
              Docs
              <ArrowRight aria-hidden size={13} strokeWidth={1.8} />
            </Link>
            <a
              className="inline-flex items-center gap-1 font-medium text-accent transition-opacity hover:opacity-80"
              href={`${webBaseUrl.replace(/\/+$/, "")}/llms.txt`}
              onClick={onClose}
              rel="noreferrer"
              target="_blank"
            >
              llms.txt
              <ArrowRight aria-hidden size={13} strokeWidth={1.8} />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * The three copy-paste onboarding prompts, each framed as "paste this into your
 * coding agent" and presented as a compact expandable list. The trace prompt
 * reuses buildTraceTelemetryPrompt; the other two come from the welcome-prompts
 * builders. A minted key is embedded when available so the prompts are
 * copy-paste ready; otherwise each carries its own fill-in slot.
 */
export function WelcomePrompts({
  apiKey,
  webBaseUrl,
  apiBaseUrl
}: {
  apiKey: string | null;
  webBaseUrl: string;
  apiBaseUrl: string;
}) {
  const prompts = [
    {
      id: "first-call",
      title: "Start chatting",
      subtitle: "Make your first model call",
      text: buildFirstCallPrompt(apiBaseUrl, apiKey)
    },
    {
      id: "traces",
      title: "Upload my traces",
      subtitle: "Bring existing traces in as telemetry",
      text: buildTraceTelemetryPrompt(webBaseUrl, apiBaseUrl)
    },
    {
      id: "byok",
      title: "Connect my provider keys",
      subtitle: "Route through my own keys (BYOK)",
      text: buildByokConnectPrompt(webBaseUrl, apiBaseUrl, apiKey)
    }
  ];

  return (
    <div className="flex flex-col gap-2">
      <span className="mono-label">Paste into your coding agent</span>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {prompts.map((prompt) => (
          <li key={prompt.id}>
            <details className="group rounded-[var(--radius-md)] border border-line bg-background">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-ink">{prompt.title}</span>
                  <span className="truncate text-[11px] text-muted">{prompt.subtitle}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <CopyButton value={prompt.text} label={`Copy ${prompt.title} prompt`} />
                  <ChevronDown
                    aria-hidden
                    className="text-muted transition-transform group-open:rotate-180"
                    size={14}
                    strokeWidth={1.8}
                  />
                </span>
              </summary>
              <pre className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted no-scrollbar">
                {prompt.text}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={label}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-md)] border border-line bg-surface text-foreground/60 hover:text-foreground"
      onClick={(event) => {
        // Inside a <summary> the button must not toggle the disclosure.
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
      type="button"
    >
      {copied ? <Check aria-hidden size={13} /> : <Copy aria-hidden size={13} />}
    </button>
  );
}
