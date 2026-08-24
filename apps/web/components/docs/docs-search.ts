import { DOCS_PAGES, type DocsNavEntry } from "@/components/docs/docs-nav";

// Client-side search over the static docs index (the nav entries: titles,
// descriptions, keywords). Pure and synchronous so the ⌘K modal filters on
// every keystroke and tests exercise the ranking directly. Content packets
// extend the index by enriching docs-nav entries, not this function.

/** Ranked matches for `query`, best first; empty for a blank query. */
export function searchDocs(query: string): DocsNavEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  return DOCS_PAGES.map((entry) => ({ entry, score: scoreEntry(entry, q) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.entry);
}

// Title matches outrank keyword matches outrank description matches; a
// title prefix outranks a mid-title hit. Ties keep reading order (the map
// above walks DOCS_PAGES in order and the sort is stable).
function scoreEntry(entry: DocsNavEntry, q: string): number {
  const title = entry.title.toLowerCase();
  if (title.startsWith(q)) {
    return 4;
  }
  if (title.includes(q)) {
    return 3;
  }
  if (entry.keywords.some((keyword) => keyword.toLowerCase().includes(q))) {
    return 2;
  }
  if (entry.description.toLowerCase().includes(q)) {
    return 1;
  }
  return 0;
}
