"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, Search, Star } from "lucide-react";
import { clsx } from "clsx";

import { ProviderBadge } from "@/components/models-catalog/badges";
import { cheapestInputMicro, providerLabel } from "@/lib/models-catalog/format";
import { requiresOwnKey } from "@/lib/models-catalog/serving";
import { formatPerMillionUsd } from "@/lib/money";
import type { CatalogEntry } from "@/lib/models-catalog/types";

type ModelPickerProps = {
  models: CatalogEntry[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  /**
   * Trigger text when nothing is selected. The compare "Add model" control is
   * this same picker in add mode: no selection ever shows, each pick appends
   * a pane, and the list already excludes the models on screen.
   */
  triggerLabel?: string;
  /** Extra classes on the trigger (the add control drops the wide min-width). */
  triggerClassName?: string;
};

// Models with no primary provider fall into this group, rendered last.
const OTHER_GROUP = "__other__";

/** The provider of a model's first (default-waterfall head) route, for the badge. */
function primaryProvider(entry: CatalogEntry): string | null {
  return entry.providers[0]?.provider ?? null;
}

/**
 * The playground's model picker: a searchable popover over the real catalog,
 * keyed by slug. With no search query the list is GROUPED so the long catalog
 * is navigable (the product owner r2): the recommended set (preferred_rank) is pinned first
 * under an always-open "Recommended" header with a gold star, then every
 * provider is a collapsible section (badge + count + chevron), collapsed by
 * default. Typing a query flattens to filtered results. Mirrors the org
 * switcher's portal + click-outside pattern so it can never be clipped by the
 * no-scroll page shell.
 *
 * The gold star is inline here (lucide Star + the --accent-amber token); the
 * catalog page ships a shared RecommendedStar component the final fold can
 * unify this with.
 */
export function ModelPicker({
  models,
  selectedSlug,
  onSelect,
  triggerLabel = "Select a model",
  triggerClassName
}: ModelPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Which provider sections are expanded; empty = every section collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(
    null
  );

  const selected = models.find((entry) => entry.model.slug === selectedSlug) ?? null;
  const isSearching = query.trim() !== "";

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return models;
    }
    return models.filter((entry) => {
      const provider = primaryProvider(entry) ?? "";
      return (
        entry.model.display_name.toLowerCase().includes(needle) ||
        entry.model.slug.toLowerCase().includes(needle) ||
        provider.toLowerCase().includes(needle)
      );
    });
  }, [models, query]);

  // The grouped view (no query): recommended first, then providers by size.
  const grouped = useMemo(() => {
    const recommended = models
      .filter((entry) => entry.model.preferred_rank !== null)
      .sort((a, b) => (a.model.preferred_rank ?? 0) - (b.model.preferred_rank ?? 0));
    const recommendedSlugs = new Set(recommended.map((entry) => entry.model.slug));
    const byProvider = new Map<string, CatalogEntry[]>();
    for (const entry of models) {
      if (recommendedSlugs.has(entry.model.slug)) {
        continue;
      }
      const key = primaryProvider(entry) ?? OTHER_GROUP;
      const list = byProvider.get(key) ?? [];
      list.push(entry);
      byProvider.set(key, list);
    }
    const providerGroups = [...byProvider.entries()]
      .map(([key, list]) => ({
        key,
        list: [...list].sort((a, b) => a.model.display_name.localeCompare(b.model.display_name))
      }))
      .sort((a, b) => {
        // "Other" sinks to the bottom; otherwise most-populated provider first.
        if (a.key === OTHER_GROUP) return 1;
        if (b.key === OTHER_GROUP) return -1;
        return b.list.length - a.list.length;
      });
    return { recommended, providerGroups };
  }, [models]);

  useLayoutEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuRect({ top: rect.bottom + 6, left: rect.left, width: rect.width });
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    searchRef.current?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }
    // Keep the fixed-position menu aligned to the trigger without dismissing it:
    // browsing the model list (or the page) should not close the popover — only
    // select, outside-click, and Escape do that.
    function reposition() {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setMenuRect({ top: rect.bottom + 6, left: rect.left, width: rect.width });
      }
    }
    function onScroll(event: Event) {
      // Scrolling inside the menu's own list must not move or close it.
      const target = event.target;
      if (target instanceof Node && menuRef.current && menuRef.current.contains(target)) {
        return;
      }
      reposition();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [isOpen]);

  function choose(slug: string) {
    onSelect(slug);
    setIsOpen(false);
    setQuery("");
  }

  function toggleGroup(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function renderRow(entry: CatalogEntry) {
    const inputMicro = cheapestInputMicro(entry);
    const isActive = entry.model.slug === selectedSlug;
    const recommended = entry.model.preferred_rank !== null;
    // BYOK-only models are selectable but need the org's own provider key; the
    // badge keeps the picker honest instead of implying every model just runs.
    const byok = requiresOwnKey(entry);
    return (
      <button
        aria-selected={isActive}
        className={clsx(
          "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-[13px] hover:bg-hover",
          isActive && "bg-active"
        )}
        key={entry.model.slug}
        onClick={() => choose(entry.model.slug)}
        role="option"
        type="button"
      >
        <Check
          aria-hidden
          className={clsx("shrink-0 text-accent", !isActive && "invisible")}
          size={14}
          strokeWidth={2}
        />
        {recommended ? (
          <Star aria-hidden className="shrink-0 fill-accent-amber text-accent-amber" size={12} />
        ) : null}
        {/* No per-row provider tag: rows already sit under their provider
            group, and the picker reads as model names only (the product owner). */}
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          {entry.model.display_name}
        </span>
        {byok ? (
          <span
            className="shrink-0 rounded-full bg-warning-soft px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-warning"
            title="Requires your own provider key, not hosted on Experiential credits"
          >
            your key
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[11px] text-muted-2">
          {inputMicro === null ? "" : `${formatPerMillionUsd(inputMicro)}/M in`}
        </span>
      </button>
    );
  }

  const isEmpty = isSearching
    ? filtered.length === 0
    : grouped.recommended.length === 0 && grouped.providerGroups.length === 0;

  return (
    <div className="relative min-w-0">
      <button
        ref={buttonRef}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={selectedSlug === null ? triggerLabel : "Model"}
        className={clsx(
          "flex min-h-[34px] w-full min-w-[240px] items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-[13px] text-ink outline-0 hover:bg-surface-subtle focus-visible:border-[#bdbdbd]",
          triggerClassName
        )}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? (
            // Just the model name; the provider tag was cut so panes and the
            // trigger read as model names only (the product owner).
            <span className="truncate font-semibold">{selected.model.display_name}</span>
          ) : (
            <span className="text-muted">{triggerLabel}</span>
          )}
        </span>
        <ChevronsUpDown aria-hidden className="shrink-0 text-muted-2" size={14} strokeWidth={1.8} />
      </button>
      {isOpen && menuRect !== null
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-50 flex max-h-[min(60vh,420px)] flex-col overflow-hidden rounded-lg border border-line-strong bg-surface shadow-[0_6px_16px_rgba(20,20,18,0.08)]"
              role="listbox"
              style={{ top: menuRect.top, left: menuRect.left, width: Math.max(menuRect.width, 280) }}
            >
              <div className="flex items-center gap-2 border-b border-line px-2.5">
                <Search aria-hidden className="shrink-0 text-muted-2" size={14} strokeWidth={1.8} />
                <input
                  ref={searchRef}
                  aria-label="Search models"
                  className="min-h-[36px] w-full bg-transparent text-[13px] text-ink outline-0 placeholder:text-muted-2"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search models"
                  value={query}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {isEmpty ? (
                  <p className="px-2.5 py-4 text-center text-[12px] text-muted">No models match.</p>
                ) : isSearching ? (
                  filtered.map(renderRow)
                ) : (
                  <>
                    {grouped.recommended.length > 0 ? (
                      <div aria-label="Recommended" role="group">
                        <div className="flex items-center gap-1.5 px-2 py-1.5">
                          <Star
                            aria-hidden
                            className="shrink-0 fill-accent-amber text-accent-amber"
                            size={12}
                          />
                          <span className="mono-label">Recommended</span>
                        </div>
                        {grouped.recommended.map(renderRow)}
                      </div>
                    ) : null}
                    {grouped.providerGroups.map(({ key, list }) => {
                      const label = key === OTHER_GROUP ? "Other" : providerLabel(key);
                      const isExpanded = expanded.has(key);
                      return (
                        <div aria-label={label} key={key} role="group">
                          <button
                            aria-expanded={isExpanded}
                            aria-label={`${label}, ${list.length} ${
                              list.length === 1 ? "model" : "models"
                            }`}
                            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
                            onClick={() => toggleGroup(key)}
                            type="button"
                          >
                            {isExpanded ? (
                              <ChevronDown
                                aria-hidden
                                className="shrink-0 text-muted-2"
                                size={14}
                                strokeWidth={1.8}
                              />
                            ) : (
                              <ChevronRight
                                aria-hidden
                                className="shrink-0 text-muted-2"
                                size={14}
                                strokeWidth={1.8}
                              />
                            )}
                            {key === OTHER_GROUP ? null : <ProviderBadge provider={key} />}
                            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-soft">
                              {label}
                            </span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-2">
                              {list.length}
                            </span>
                          </button>
                          {isExpanded ? list.map(renderRow) : null}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
