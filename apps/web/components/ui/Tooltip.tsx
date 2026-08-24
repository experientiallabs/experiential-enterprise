"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";

type TooltipProps = {
  label: string;
  /** A second, softer line saying what the item is, under the bold label. */
  description?: string;
  children: ReactNode;
  // Always-visible mode: used to point at the collapsed login affordance so a
  // logged-out visitor can find it without hovering.
  persistent?: boolean;
  /** Extra classes on the trigger wrapper (e.g. w-full for full-width nav rows). */
  className?: string;
};

/**
 * A hover/focus tooltip anchored to the right of its trigger (the sidebar case,
 * the only one used); set `persistent` to keep it always visible.
 *
 * The bubble renders through a portal into document.body at a fixed position.
 * Anchoring it inside the trigger cannot work here: the sidebar clips its
 * innards with overflow-hidden (needed for the width collapse animation), so an
 * inline bubble pointing past the rail's right edge is cut off and never seen.
 * That clipping is exactly the bug that hid the collapsed login label.
 */
export function Tooltip({
  label,
  description,
  children,
  persistent = false,
  className
}: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const isOpen = persistent || isHovered;

  const measure = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect === undefined) {
      return;
    }
    setPosition({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  }, []);

  // Fixed positioning goes stale when the page moves under it, so track the
  // anchor while open. Scroll is captured because the scroller is an inner
  // <main>, not the window.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [isOpen, measure]);

  return (
    <span
      className={clsx("relative inline-flex", className)}
      onBlur={() => setIsHovered(false)}
      onFocus={() => setIsHovered(true)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      ref={anchorRef}
    >
      {children}
      {/* Decorative: triggers carry their own aria-label, so the bubble is a visual echo. A bare
          role="tooltip" without an aria-describedby link from the trigger only confuses SRs.
          position === null until the first client-side measure, which also keeps the portal
          out of server markup. */}
      {isOpen &&
        position !== null &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            aria-hidden
            className="pointer-events-none fixed z-50 -translate-y-1/2 rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 py-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
            data-testid="tooltip-bubble"
            style={{ top: position.top, left: position.left }}
          >
            <span
              className={clsx(
                "block text-[12px] font-medium leading-4 text-ink",
                description === undefined ? "whitespace-nowrap" : "w-max max-w-[220px]"
              )}
            >
              {label}
            </span>
            {description !== undefined && (
              <span className="mt-0.5 block w-max max-w-[220px] text-[11px] leading-4 text-ink-soft">
                {description}
              </span>
            )}
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
