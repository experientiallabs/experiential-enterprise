// The ONE place the shell's re-triggerable welcome celebration talks to the
// platform. components/shell/WelcomeTrigger.tsx is its only consumer.

/** Outcome of one claim: whether to celebrate now, and what to show. */
export type WelcomeTriggerClaim = {
  show: boolean;
  /** The credit figure to announce, or null to omit the line. */
  displayCreditUsd: number | null;
  /** Whether the modal should surface the API key. */
  showApiKey: boolean;
};

const SILENT: WelcomeTriggerClaim = { show: false, displayCreditUsd: null, showApiKey: false };

/**
 * Claim the re-triggerable welcome celebration for the signed-in user in their
 * active org.
 *
 * The server (app/api/account/welcome-trigger/route.ts) is the arbiter: it
 * returns `show: true` only when an admin has armed the org's celebration and
 * the user has not yet seen this activation, and it advances the user's seen
 * marker in the same call, so a second visit or a concurrent tab returns
 * `show: false`. A transient failure resolves silent rather than throwing: a
 * missed celebration is acceptable and self-corrects (the marker only advances
 * on a real claim), while a crashed shell is not.
 */
export async function claimWelcomeTrigger(): Promise<WelcomeTriggerClaim> {
  try {
    const response = await fetch("/api/account/welcome-trigger", {
      method: "POST",
      cache: "no-store"
    });
    if (!response.ok) {
      return SILENT;
    }
    const payload = (await response.json().catch(() => null)) as {
      show?: unknown;
      displayCreditUsd?: unknown;
      showApiKey?: unknown;
    } | null;
    const amount = payload?.displayCreditUsd;
    return {
      show: payload?.show === true,
      displayCreditUsd: typeof amount === "number" && Number.isFinite(amount) ? amount : null,
      showApiKey: payload?.showApiKey === true
    };
  } catch {
    return SILENT;
  }
}
