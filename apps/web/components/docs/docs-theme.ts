// Docs-scoped dark/light theming. The rest of the app has no dark mode, so the
// theme is an attribute on the docs root element ([data-docs-theme]) whose CSS
// variable overrides live in app/docs/docs.css — nothing outside the docs tree
// can be affected. Light is the default (matches the app); the choice persists
// in localStorage and a tiny inline boot script applies it before first paint
// so a dark-preferring reader never sees a light flash.

export const DOCS_THEME_ROOT_ID = "docs-theme-root";
export const DOCS_THEME_STORAGE_KEY = "docs-theme";

export type DocsTheme = "light" | "dark";

/**
 * Re-apply the stored preference to the docs root and return the result.
 * Needed beyond the boot script because React inserts client-rendered inline
 * scripts inert (never executed), so a client-side navigation into /docs — a
 * workspace <Link> to the docs — mounts the layout without the boot script
 * running. Same semantics as the boot script: only a stored "dark" acts;
 * anything else (unset, unreadable storage) is the light default.
 */
export function syncDocsTheme(): DocsTheme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(DOCS_THEME_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode): the light default stands.
  }
  const theme: DocsTheme = stored === "dark" ? "dark" : "light";
  document.getElementById(DOCS_THEME_ROOT_ID)?.setAttribute("data-docs-theme", theme);
  return theme;
}

/** Apply `theme` to the docs root and persist it for the next visit. */
export function applyDocsTheme(theme: DocsTheme): void {
  document.getElementById(DOCS_THEME_ROOT_ID)?.setAttribute("data-docs-theme", theme);
  try {
    localStorage.setItem(DOCS_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); the toggle still works for
    // the current page view.
  }
}

// Runs inline as the docs root's first child: the element is already in the
// tree when the parser reaches the script, so the attribute lands before any
// content paints. Only "dark" is acted on — anything else is the default.
export const DOCS_THEME_BOOT_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(
  DOCS_THEME_STORAGE_KEY
)})==="dark"){document.getElementById(${JSON.stringify(
  DOCS_THEME_ROOT_ID
)}).setAttribute("data-docs-theme","dark");}}catch(e){}})();`;
