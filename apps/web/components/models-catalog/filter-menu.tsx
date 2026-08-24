"use client";

// The catalog's filter pill: a quiet bordered button that opens a small
// checklist panel (multi) or option list (single). Linear-style — the pill
// shows its active count, the panel is a plain hairline card, outside click
// or Escape closes it. Local to the catalog; if a second surface needs it,
// promote it to components/ui/.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { clsx } from "clsx";

export type FilterOption = {
  value: string;
  label: ReactNode;
};

type FilterMenuProps = {
  label: string;
  options: FilterOption[];
  /** Selected values; single-select menus carry zero or one entry. */
  selected: string[];
  onChange: (selected: string[]) => void;
  multi?: boolean;
};

export function FilterMenu({ label, options, selected, onChange, multi = false }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = (value: string) => {
    if (multi) {
      onChange(
        selected.includes(value)
          ? selected.filter((entry) => entry !== value)
          : [...selected, value]
      );
      return;
    }
    onChange(selected.includes(value) ? [] : [value]);
    setOpen(false);
  };

  const active = selected.length > 0;
  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={clsx(
          "inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-semibold transition-colors",
          active
            ? "border-accent/40 bg-accent-soft text-accent"
            : "border-line-strong bg-surface text-ink-soft hover:text-ink"
        )}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {label}
        {active ? (
          <span className="font-mono text-[10.5px]">{multi ? selected.length : "1"}</span>
        ) : null}
        <ChevronDown aria-hidden size={12} strokeWidth={1.8} />
      </button>
      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+4px)] z-20 max-h-72 min-w-44 overflow-auto rounded-lg border border-line bg-surface py-1 shadow-[0_4px_16px_rgba(0,0,0,0.06)]"
          role="listbox"
        >
          {options.map((option) => {
            const isSelected = selected.includes(option.value);
            return (
              <button
                aria-selected={isSelected}
                className={clsx(
                  "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface-subtle",
                  isSelected ? "text-foreground" : "text-ink-soft"
                )}
                key={option.value}
                onClick={() => toggle(option.value)}
                role="option"
                type="button"
              >
                <span
                  aria-hidden
                  className={clsx(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border",
                    isSelected ? "border-accent bg-accent text-white" : "border-line-strong"
                  )}
                >
                  {isSelected ? <Check size={10} strokeWidth={2.5} /> : null}
                </span>
                <span className="min-w-0 truncate">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
