// The ONE place the login modal's success step talks to the platform. The
// keys workstream may reshape the key read/create endpoints (plans/gw-shell.md
// §5 "Interfaces"); when it does, only this module changes.

export type WelcomeData = {
  /**
   * Plaintext of a key minted for this login (the org had none) — shown once,
   * exactly like the settings mint flow. Null when the org already holds an
   * active key, whose hash-only storage leaves just `keyPrefix` to display.
   */
  mintedSecret: string | null;
  /** Recognition prefix (`xpl_ab12cd34`) of the org's existing active key. */
  keyPrefix: string | null;
  /**
   * The welcome grant to announce: the launch-grant EVENT amount from the
   * ledger ($20 standard signup, the YC amount on a claim — never the
   * cumulative granted counter, which also counts top-ups; the same rule as
   * the sidebar greeting, PR #685). Null once the org has spent anything, so a
   * returning user is never promised credits they hold only partially.
   */
  grantedUsd: number | null;
  /**
   * Whether this session may mint the org's first key. When false and no key
   * exists (a non-admin member), no first-key reveal can ever be produced, so
   * the reveal must stop rather than poll for a mint that will never happen.
   */
  canManageKeys: boolean;
};

type WelcomeSummary = {
  org: { id: string };
  apiKey: { keyPrefix: string } | null;
  canManageKeys: boolean;
  credit: { grantedUsd: number; billableUsd: number };
};

/**
 * Everything the success step renders, or null when nothing org-scoped is
 * readable (memberless account, transient failure) — the step then shows its
 * links without a key or credits line rather than blocking the celebration.
 */
export async function fetchWelcomeData(): Promise<WelcomeData | null> {
  const summary = await readWelcomeSummary();
  if (summary === null) {
    return null;
  }
  const { grantedUsd: granted, billableUsd } = summary.credit;
  const grantedUsd = granted > 0 && billableUsd === 0 ? granted : null;
  const canManageKeys = summary.canManageKeys;
  if (summary.apiKey !== null) {
    return { mintedSecret: null, keyPrefix: summary.apiKey.keyPrefix, grantedUsd, canManageKeys };
  }
  if (!canManageKeys) {
    // Non-admin member of an org with no keys yet: nothing to mint or show.
    return { mintedSecret: null, keyPrefix: null, grantedUsd, canManageKeys };
  }
  const secret = await mintDefaultKey(summary.org.id);
  return { mintedSecret: secret, keyPrefix: null, grantedUsd, canManageKeys };
}

async function readWelcomeSummary(): Promise<WelcomeSummary | null> {
  let payload: unknown;
  try {
    const response = await fetch("/api/welcome", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    payload = await response.json();
  } catch {
    return null;
  }
  // Raw JSON boundary: validate before anything renders from it.
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const org = record.org as Record<string, unknown> | undefined;
  const apiKey = record.apiKey as Record<string, unknown> | null | undefined;
  const credit = record.credit as Record<string, unknown> | undefined;
  if (
    typeof org?.id !== "string" ||
    apiKey === undefined ||
    (apiKey !== null && typeof apiKey.keyPrefix !== "string") ||
    typeof record.canManageKeys !== "boolean" ||
    typeof credit?.grantedUsd !== "number" ||
    typeof credit?.billableUsd !== "number"
  ) {
    return null;
  }
  return {
    org: { id: org.id },
    apiKey: apiKey === null ? null : { keyPrefix: apiKey.keyPrefix as string },
    canManageKeys: record.canManageKeys,
    credit: { grantedUsd: credit.grantedUsd, billableUsd: credit.billableUsd }
  };
}

/** First key for a fresh workspace, via the same mint route the settings use. */
async function mintDefaultKey(orgId: string): Promise<string | null> {
  try {
    const response = await fetch("/api/keys", {
      body: JSON.stringify({ orgId, name: "default", expiresInDays: null }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as { secret?: unknown } | null;
    return typeof payload?.secret === "string" ? payload.secret : null;
  } catch {
    return null;
  }
}
