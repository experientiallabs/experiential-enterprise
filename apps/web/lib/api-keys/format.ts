// Client-safe display helpers for API-key rows (keys.ts stays server-only
// because it imports node:crypto).

/**
 * The recognition label every key row renders: `xpl_ab12cd34…f2e1`. A key
 * minted before key_suffix existed has no stored tail and renders `xpl_ab12cd34…`
 * rather than inventing one. This label is never the secret; copying it is
 * useless, so surfaces render it without a copy affordance.
 */
export function formatKeyIdentity(prefix: string, suffix: string | null): string {
  return suffix === null ? `${prefix}…` : `${prefix}…${suffix}`;
}
