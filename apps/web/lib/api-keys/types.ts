// Client-safe API-key shapes (the mint helpers live in keys.ts, which is
// server-only because it imports node:crypto).
export type ApiKeyRow = {
  id: string;
  org_id: string;
  name: string;
  key_prefix: string;
  // Last 4 chars of the plaintext, stored at mint for display recognition
  // (`xpl_ab12cd34…f2e1`). Null for keys minted before the column existed.
  key_suffix: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  // The identity this key hangs off (P-A reparent). Every key has one; a key
  // minted before the identity tier reads as its org's default identity.
  identity_id: string | null;
};

// The label fields a budget scope picker needs: enough to name a key in a
// select and on a budget row, nothing a member cannot already see in the
// full listing above.
export type ApiKeySummary = {
  id: string;
  name: string;
  key_prefix: string;
  key_suffix: string | null;
};

// Expiry choices offered at mint time; null means the key never expires.
export const API_KEY_EXPIRY_DAYS = [30, 60, 90] as const;

// One key's effective gateway guardrails (platform-funded lane), mirroring the
// backend's KeyLimitsView. Null means uncapped; `source` says whether an
// explicit limits row exists or the platform defaults apply.
export type GatewayKeyLimits = {
  api_key_id: string;
  daily_spend_cap_micro_usd: number | null;
  requests_per_minute: number | null;
  tokens_per_minute: number | null;
  source: "explicit" | "default";
};

// Body of the limits write. FULL-RESOURCE semantics by backend contract: the
// row becomes exactly this object, so a null field means explicitly uncapped —
// never "keep the previous value". Every save must carry all three fields.
export type GatewayKeyLimitsInput = {
  daily_spend_cap_micro_usd: number | null;
  requests_per_minute: number | null;
  tokens_per_minute: number | null;
};
