"use client";

import { useSyncExternalStore } from "react";

import { formatDateTime, formatDateTimeWithYear } from "@/lib/format";

// The store never changes; useSyncExternalStore only swaps from the server
// snapshot to the client snapshot once hydration completes.
function subscribeNever(): () => void {
  return () => {};
}

// Resolving the zone constructs an Intl.DateTimeFormat (~10-100µs) and React
// calls getSnapshot on every render plus a post-commit check, so resolve once.
// The zone cannot meaningfully change without a reload: subscribeNever never
// notifies, so an uncached value could not propagate a change anyway.
let resolvedBrowserZone: string | null = null;

function browserTimeZone(): string {
  if (resolvedBrowserZone === null) {
    resolvedBrowserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return resolvedBrowserZone;
}

/**
 * Time zone to render timestamps with: "UTC" on the server and during the
 * hydration render, the browser's zone afterwards. The server HTML and the
 * first client render always agree, so locale/zone-dependent dates never trip
 * React's hydration text mismatch (#418).
 */
export function useDisplayTimeZone(): string {
  return useSyncExternalStore(subscribeNever, browserTimeZone, () => "UTC");
}

/** Client leaf rendering a timestamp in the viewer's zone, hydration-safe. */
export function LocalDateTime({ value, withYear = false }: { value: string; withYear?: boolean }) {
  const timeZone = useDisplayTimeZone();
  return <>{withYear ? formatDateTimeWithYear(value, timeZone) : formatDateTime(value, timeZone)}</>;
}
