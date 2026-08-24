"use client";

// The shared connect/manage popup shell: one modal for connecting ANY external
// account — model providers and observability trace sources alike (the product owner,
// credits/settings redesign 2026-08-22: the same focused connect experience,
// with its copyable coding-agent prompt, everywhere something gets hooked up).
// The shell carries the identity header (icon, name, status, connected pill),
// an optional copy-paste transfer prompt, and the credential form as children,
// so the form logic stays with each caller. It owns the overlay, escape/
// click-away, and aria wiring, mirroring ui/ConfirmDialog; it owns none of the
// form's state.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";

type ConnectModalProps = {
  /** The account's glyph (brand logo or kind icon), drawn in the icon square. */
  icon: ReactNode;
  /** The account's display name (provider label, trace-source label). */
  title: string;
  connected: boolean;
  /** The one-line status shown under the name (verified state, key identity). */
  status: string;
  /**
   * The copyable coding-agent prompt, or null to hide the block. Callers pass
   * null for read-only members: the prompt drives an admin-scoped connect, so
   * it matches the credential form the children render.
   */
  prompt: string | null;
  /** Full test id for the dialog element (e.g. provider-connect-modal-openai). */
  testId: string;
  /** Full test id for the transfer-prompt block. */
  promptTestId: string;
  onClose: () => void;
  /** The credential form (or the members-only note). */
  children: ReactNode;
};

/** Focusable descendants of the dialog, in tab order, excluding hidden ones. */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  );
}

/**
 * The connect popup. Renders a centered dialog over a scrim; escape and a
 * scrim click both close it (there is no in-flight guard here — the form's own
 * requests are idempotent connects/rotates the customer can safely reissue).
 *
 * Full modal a11y: on open it captures the trigger, moves focus into the dialog,
 * and traps Tab within it so the background is out of the tab order; on close it
 * restores focus to the trigger. Escape closes it.
 */
export function ConnectModal({
  icon,
  title,
  connected,
  status,
  prompt,
  testId,
  promptTestId,
  onClose,
  children
}: ConnectModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Remember what to hand focus back to, then move focus into the dialog so a
    // keyboard or screen-reader user lands inside it, not on the background.
    const trigger = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      // Restore focus to the trigger when the dialog closes/unmounts.
      trigger?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const panel = panelRef.current;
      if (panel === null) {
        return;
      }
      // Keep Tab / Shift+Tab cycling inside the dialog (focus trap).
      const focusables = focusableWithin(panel);
      const first = focusables[0] ?? panel;
      const last = focusables[focusables.length - 1] ?? panel;
      const active = document.activeElement as HTMLElement | null;
      // "Tracked" = a focusable descendant we can cycle through. The active
      // element is UNtracked when it is the panel itself, has escaped to the
      // background, or was just disabled while focused (e.g. the submit button
      // going busy) — in every one of those cases native Tab would leave the
      // dialog, so wrap it back in rather than trusting `active === last/first`.
      const activeTracked = active !== null && focusables.includes(active);
      if (event.shiftKey) {
        if (active === first || !activeTracked) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !activeTracked) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-foreground/20 p-4 sm:p-6"
      onClick={onClose}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex max-h-[90dvh] w-full max-w-[540px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-[0_18px_50px_rgba(20,20,18,0.14)] focus:outline-none"
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex items-center gap-3 border-b border-line px-[18px] py-3.5">
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line bg-foreground/[0.03] text-foreground/70"
          >
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-ink" id={titleId}>
                {title}
              </span>
              {connected && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                  <Check aria-hidden size={11} strokeWidth={2.2} /> Connected
                </span>
              )}
            </span>
            <span className="block truncate text-[12px] text-muted">{status}</span>
          </span>
          <button
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-surface text-muted transition-colors hover:text-ink"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden size={15} strokeWidth={1.8} />
          </button>
        </header>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-[18px] py-4">
          {prompt !== null && <TransferPrompt prompt={prompt} testId={promptTestId} />}
          {children}
        </div>
      </section>
    </div>
  );
}

/**
 * The copy-paste block: a prompt the customer hands to their own coding agent
 * so it gathers exactly what THIS account needs and wires it up. Collapsed to
 * its header by default so the credential form stays the primary action; the
 * copy control works whether or not it is expanded.
 */
function TransferPrompt({ prompt, testId }: { prompt: string; testId: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyId = useId();

  const copy = () => {
    void navigator.clipboard?.writeText(prompt).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section
      className="rounded-[var(--radius-md)] border border-line bg-surface-subtle"
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          className="min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <span className="block text-[12.5px] font-semibold text-ink">
            Connect from your coding agent
          </span>
          <span className="block text-[11.5px] text-muted">
            Paste this prompt into your agent to wire this up for you.
          </span>
        </button>
        <button
          aria-label="Copy connect prompt"
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:text-ink"
          onClick={copy}
          type="button"
        >
          {copied ? <Check aria-hidden size={13} /> : <Copy aria-hidden size={13} />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      {open && (
        <pre
          className="m-0 max-h-[34dvh] overflow-auto whitespace-pre-wrap border-t border-line bg-surface px-3 py-3 font-mono text-[11.5px] leading-relaxed text-ink"
          id={bodyId}
        >
          {prompt}
        </pre>
      )}
    </section>
  );
}
