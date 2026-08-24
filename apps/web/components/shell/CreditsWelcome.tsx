"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";

import { claimCreditWelcomeFirstView } from "@/lib/credit-welcome";
import { formatGrantUsd } from "@/lib/money";

// How long the bubble holds before the fade starts, and how long the fade runs.
// Generous on purpose: this is a greeting, not a transient toast, and it must
// outlive the first glance at a fresh workspace.
const HOLD_MS = 6000;
const FADE_MS = 1800;

/**
 * The signup-credit greeting (the product owner, 2026-07-30; once-ever per user 2026-08-21):
 * a bubble pointing at the sidebar credits meter, the same portal anchoring as
 * the collapsed-rail Log in pointer, that pops up and slowly fades away on its
 * own the FIRST time the user opens the workspace, then never again.
 *
 * Its memory is a durable per-user flag on the server, not this browser and not
 * the ledger (lib/credit-welcome.ts → /api/account/credit-welcome). The claim
 * is atomic and server-arbitrated: exactly one caller ever wins `firstView:
 * true`, so two tabs or two devices opened at the same instant cannot each
 * greet — the bubble greets only on its OWN winning claim, never on a local
 * guess. The claim is deferred until the bubble is actually renderable (a real
 * grant, above the responsive breakpoint), so it is not spent while the meter
 * and bubble are display:none. Every later visit, on any device or after a
 * cleared cache, loses the claim and stays silent.
 *
 * The ANNOUNCED amount is the launch-grant EVENT amount the claim response
 * carries ($20 standard signup, the YC amount on a claim), computed server-side
 * from the ledger's grant rows — NEVER the meter's cumulative
 * `credit_granted_usd`, which also counts Stripe top-ups (announcing it once
 * greeted a seeded demo org with "$776 in credits added": $526 YC + $250 of
 * top-ups). The meter figure gates only WHEN to claim (a zero or unknown
 * balance has nothing to announce and never claims); what to SAY comes from
 * the grant event.
 */
export function CreditsWelcome({
  granted,
  children,
  className = "relative flex w-full flex-col"
}: {
  /**
   * Granted credit the meter currently shows; null while unknown. The claim
   * precondition only — never displayed (it counts top-ups).
   */
  granted: number | null;
  children: ReactNode;
  /** Anchor-wrapper classes; override to embed the greeting inline in a row. */
  className?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [phase, setPhase] = useState<"pending" | "visible" | "fading" | "done">("pending");
  // The launch-grant event amount the winning claim told us to announce.
  const [eventUsd, setEventUsd] = useState<number | null>(null);
  // Whether the greeting is renderable. Below the bubble's breakpoint the credit
  // meter and the bubble are display:none, so the claim must not be spent there.
  // null until measured client-side.
  const [canShow, setCanShow] = useState<boolean | null>(null);
  // The atomic claim is a network round-trip; latch it so a re-render (the meter
  // re-polls its balance) can never fire a second claim.
  const claimStartedRef = useRef(false);
  // Suppress the claim's state update after unmount, never on a granted
  // re-render. Reset on (re)mount for StrictMode.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 901px)");
    const sync = () => setCanShow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (phase !== "pending" || granted === null || claimStartedRef.current) {
      return;
    }
    // A zero grant has nothing to announce; do not spend the claim on it, so a
    // later real grant can still greet.
    if (granted <= 0) {
      setPhase("done");
      return;
    }
    // Defer the claim until the bubble is renderable; a resize that crosses the
    // breakpoint re-runs this effect. This keeps the claim from being spent
    // while the meter and bubble are hidden.
    if (canShow !== true) {
      return;
    }
    claimStartedRef.current = true;
    // The server arbitrates: only the caller whose insert wins gets firstView,
    // so concurrent tabs or devices cannot each greet. We greet on our OWN
    // winning claim only, never on a local guess — and we announce the grant
    // EVENT amount the claim carries, never the meter's cumulative counter.
    void claimCreditWelcomeFirstView().then(({ firstView, welcomeGrantUsd }) => {
      if (!mountedRef.current) {
        return;
      }
      const announceable = firstView && welcomeGrantUsd !== null && welcomeGrantUsd > 0;
      if (announceable) {
        setEventUsd(welcomeGrantUsd);
      }
      setPhase(announceable ? "visible" : "done");
    });
  }, [phase, granted, canShow]);

  useEffect(() => {
    if (phase !== "visible" && phase !== "fading") {
      return;
    }
    const measure = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect !== undefined) {
        setPosition({ top: rect.top + rect.height / 2, left: rect.right + 8 });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "visible") {
      return;
    }
    const hold = window.setTimeout(() => setPhase("fading"), HOLD_MS);
    return () => window.clearTimeout(hold);
  }, [phase]);

  useEffect(() => {
    if (phase !== "fading") {
      return;
    }
    const fade = window.setTimeout(() => setPhase("done"), FADE_MS);
    return () => window.clearTimeout(fade);
  }, [phase]);

  const isOpen = (phase === "visible" || phase === "fading") && eventUsd !== null;

  return (
    <span className={className} ref={anchorRef}>
      {children}
      {isOpen &&
        position !== null &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            aria-hidden
            className={clsx(
              // Hidden in the top-bar shape: its anchor (the credit meter) is
              // display:none there, so the bubble would float at the origin.
              "pointer-events-none fixed z-50 -translate-y-1/2 rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 py-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.08)] transition-opacity ease-out max-[900px]:hidden",
              phase === "fading" ? "opacity-0" : "opacity-100"
            )}
            data-testid="credits-welcome-bubble"
            style={{ top: position.top, left: position.left, transitionDuration: `${FADE_MS}ms` }}
          >
            <span className="block w-max max-w-[220px] text-[12px] font-medium leading-4 text-ink">
              {formatGrantUsd(eventUsd)} in credits added to your account
            </span>
            <span className="mt-0.5 block w-max max-w-[220px] text-[11px] leading-4 text-ink-soft">
              Every new workspace starts with a welcome grant.
            </span>
            <span
              aria-hidden
              className="absolute left-[-4px] top-1/2 h-[7px] w-[7px] -translate-y-1/2 rotate-45 border-b border-l border-line-strong bg-surface"
            />
          </span>,
          document.body
        )}
    </span>
  );
}
