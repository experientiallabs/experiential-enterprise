// The ONE place the sidebar credit greeting talks to the platform. The bubble
// (components/shell/CreditsWelcome.tsx) is its only consumer.

/** Outcome of one greeting claim: whether this caller won, and what to say. */
export type CreditWelcomeClaim = {
  firstView: boolean;
  /**
   * The launch-grant EVENT amount to announce ($20 standard signup, the YC
   * amount on a claim) — never the org's cumulative granted counter, which
   * also counts top-ups. Null when unknown; the bubble stays silent on null.
   */
  welcomeGrantUsd: number | null;
};

const SILENT: CreditWelcomeClaim = { firstView: false, welcomeGrantUsd: null };

/**
 * Atomically claim the once-ever signup-credit welcome greeting for the
 * signed-in user.
 *
 * `firstView` is true for exactly one caller — the one whose insert wins the
 * durable per-user row (see app/api/account/credit-welcome/route.ts) — and
 * false for every other, including a second tab or device opened at the same
 * instant. The server, not the browser, is the arbiter, so simultaneous opens
 * can never each greet, and the server also refuses to spend the claim when
 * the org has no announceable launch grant. A transient failure resolves
 * silent rather than throwing: a missed greeting is acceptable and
 * self-corrects (the row is only written on a real insert, so a failed
 * request leaves the greeting to a later visit), while a crashed sidebar is
 * not.
 */
export async function claimCreditWelcomeFirstView(): Promise<CreditWelcomeClaim> {
  try {
    const response = await fetch("/api/account/credit-welcome", {
      method: "POST",
      cache: "no-store"
    });
    if (!response.ok) {
      return SILENT;
    }
    const payload = (await response.json().catch(() => null)) as {
      firstView?: unknown;
      welcomeGrantUsd?: unknown;
    } | null;
    const amount = payload?.welcomeGrantUsd;
    return {
      firstView: payload?.firstView === true,
      welcomeGrantUsd: typeof amount === "number" && Number.isFinite(amount) ? amount : null
    };
  } catch {
    return SILENT;
  }
}
