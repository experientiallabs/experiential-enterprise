// The sidebar's collapse preference for both audiences, shared between the
// server shell and the client rail. A cookie rather than localStorage so the
// SERVER renders the remembered width: reading storage after mount repainted
// the rail and shoved the main column sideways on every load (the product owner,
// 2026-07-30).

export const SIDEBAR_COLLAPSE_COOKIE = "explabs-sidebar-collapsed";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Cookie value -> preference; anything unrecognized means "never chose". */
export function parseSidebarCollapse(value: string | undefined): boolean | null {
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }
  return null;
}

/** Client-side write; no API round-trip, the next SSR pass just reads it. */
export function writeSidebarCollapse(collapsed: boolean): void {
  document.cookie = `${SIDEBAR_COLLAPSE_COOKIE}=${collapsed ? "1" : "0"}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}
