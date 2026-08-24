"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { applyDocsTheme, syncDocsTheme, type DocsTheme } from "@/components/docs/docs-theme";

// Flips [data-docs-theme] on the docs root and persists the choice. State
// initializes to light and syncs to the stored preference after mount, so
// server and client render the same button on first paint. The mount sync also
// re-applies the root attribute: on client-side navigations into /docs the
// inline boot script never executes (React inserts client-rendered scripts
// inert), so this effect is what honors a stored dark preference there.

export function DocsThemeToggle() {
  const [theme, setTheme] = useState<DocsTheme>("light");

  useEffect(() => {
    setTheme(syncDocsTheme());
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyDocsTheme(next);
    setTheme(next);
  };

  return (
    <button
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-line bg-surface text-muted hover:text-ink"
      onClick={toggle}
      type="button"
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    >
      {theme === "dark" ? <Sun size={14} strokeWidth={1.8} /> : <Moon size={14} strokeWidth={1.8} />}
    </button>
  );
}
