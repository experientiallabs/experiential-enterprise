"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { clsx } from "clsx";

export type SlidingTab = {
  key: string;
  label: string;
  /** Render as a route link; omitted tabs render as buttons and use onPick. */
  href?: string;
};

/**
 * The house tab picker (the product owner, 2026-07-31: one quality bar for every tab
 * strip, and the active pill SLIDES to the selected tab instead of
 * teleporting). One ink pill sits behind the items and animates left/width;
 * items are links when they carry an href (route tabs) and buttons otherwise
 * (in-page views). The pill is measured off the active item, so it stays
 * correct across label lengths and container resizes.
 */
export function SlidingTabs({
  tabs,
  activeKey,
  onPick,
  ariaLabel
}: {
  tabs: readonly SlidingTab[];
  activeKey: string;
  onPick?: (key: string) => void;
  ariaLabel: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const measure = () => {
      const active = list.querySelector<HTMLElement>(`[data-tab-key="${activeKey}"]`);
      setPill(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    // Container resizes (sidebar collapse, viewport) move the items under
    // the pill; jsdom has no ResizeObserver, and the initial measure above
    // covers it there.
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeKey, tabs]);

  return (
    <nav
      aria-label={ariaLabel}
      className="relative inline-flex w-fit shrink-0 rounded-lg border border-line bg-surface p-0.5"
      ref={listRef}
    >
      {pill !== null && (
        <span
          aria-hidden
          className="absolute bottom-0.5 top-0.5 rounded-md bg-ink transition-[left,width] duration-200 ease-out"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        const className = clsx(
          "relative z-[1] rounded-md px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors duration-200",
          active ? "text-white" : "text-muted hover:text-ink"
        );
        return tab.href !== undefined ? (
          <Link
            aria-current={active ? "page" : undefined}
            className={className}
            data-tab-key={tab.key}
            href={tab.href}
            key={tab.key}
          >
            {tab.label}
          </Link>
        ) : (
          <button
            aria-pressed={active}
            className={className}
            data-tab-key={tab.key}
            key={tab.key}
            onClick={() => onPick?.(tab.key)}
            type="button"
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
