"use client";

import { clsx } from "clsx";
import { CornerDownLeft, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { type DocsNavEntry } from "@/components/docs/docs-nav";
import { searchDocs } from "@/components/docs/docs-search";

// The ⌘K search: a trigger button in the docs header plus a modal filtering
// the static index on every keystroke. Fully client-side — placeholder pages
// carry no body text worth indexing yet, and content packets enrich the index
// through docs-nav, not here.

export function DocsSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = searchDocs(query);
  const selectedIndex = Math.min(selected, Math.max(results.length - 1, 0));

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelected(0);
  }, []);

  const navigate = useCallback(
    (entry: DocsNavEntry) => {
      close();
      router.push(entry.path);
    },
    [close, router]
  );

  // Global shortcut: ⌘K / Ctrl+K toggles, Escape closes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // Closing always goes through close() so the query/selection reset the
        // same way whether the reader leaves via ⌘K, Escape, or the backdrop.
        if (open) {
          close();
        } else {
          setOpen(true);
        }
      } else if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((value) => Math.min(value + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter" && results[selectedIndex]) {
      event.preventDefault();
      navigate(results[selectedIndex]);
    }
  };

  return (
    <>
      <button
        className="flex h-7 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-[12px] text-muted hover:text-ink"
        onClick={() => setOpen(true)}
        type="button"
      >
        <Search size={13} strokeWidth={1.8} />
        <span className="hidden sm:inline">Search docs</span>
        <kbd className="hidden rounded-sm border border-line bg-surface-subtle px-1 font-mono text-[10px] text-muted-2 sm:inline">
          ⌘K
        </kbd>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              close();
            }
          }}
        >
          <div
            aria-label="Search documentation"
            aria-modal="true"
            className="mx-auto mt-[12dvh] w-full max-w-[540px] overflow-hidden rounded-lg border border-line bg-surface shadow-2xl"
            role="dialog"
          >
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search size={14} strokeWidth={1.8} className="shrink-0 text-muted-2" />
              <input
                ref={inputRef}
                aria-label="Search docs"
                className="w-full border-0 bg-transparent py-3 text-[13.5px] text-ink outline-none placeholder:text-muted-2"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelected(0);
                }}
                onKeyDown={onInputKeyDown}
                placeholder="Search documentation…"
                value={query}
              />
            </div>
            <ul className="m-0 max-h-[40dvh] list-none overflow-y-auto p-1.5">
              {results.map((entry, index) => (
                <li key={entry.path}>
                  <button
                    className={clsx(
                      "flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border-0 px-2.5 py-2 text-left",
                      index === selectedIndex ? "bg-accent-soft" : "bg-transparent hover:bg-hover"
                    )}
                    onClick={() => navigate(entry)}
                    onMouseEnter={() => setSelected(index)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span
                        className={clsx(
                          "block text-[13px] font-medium",
                          index === selectedIndex ? "text-accent" : "text-ink"
                        )}
                      >
                        {entry.title}
                      </span>
                      <span className="block truncate text-[12px] text-muted">
                        {entry.description}
                      </span>
                    </span>
                    {index === selectedIndex && (
                      <CornerDownLeft size={13} strokeWidth={1.8} className="shrink-0 text-muted-2" />
                    )}
                  </button>
                </li>
              ))}
              {query.trim() !== "" && results.length === 0 && (
                <li className="px-2.5 py-3 text-[13px] text-muted">
                  No pages match “{query.trim()}”.
                </li>
              )}
              {query.trim() === "" && (
                <li className="px-2.5 py-3 text-[13px] text-muted">
                  Type to search pages — try “quickstart” or “errors”.
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
