// Synthetic-account email addresses for smoke tests, E2E suites, and launch
// checks that sign up against a HOSTED environment.
//
// GoTrue sends a real email for every signup and every sign-in code. Against a
// hosted project those messages leave the building, so a fabricated recipient
// (a made-up @experientiallabs.ai mailbox, or an @example.com address) HARD
// BOUNCES and degrades the Supabase project's sender reputation — Supabase
// issued a bounce-rate warning on 2026-08-21 threatening to restrict all of our
// signup/verification email. Synthetic accounts must therefore use a DELIVERABLE
// address: a plus-alias of the monitored operations mailbox, which routes to
// a real inbox and never bounces. Delete the synthetic account when the check
// is done.

const SYNTHETIC_MAILBOX = "silen";
const SYNTHETIC_DOMAIN = "experientiallabs.ai";

// A process-local counter appended to the epoch so two calls in the same
// millisecond still produce distinct addresses.
let sequence = 0;

/**
 * A deliverable, unique synthetic-account address of the form
 * `silen+<suite>-<epoch>@experientiallabs.ai`. `suite` names the check so a
 * bounce or a leftover account is traceable to its source; the epoch (plus a
 * per-process counter) keeps each run's address unique.
 */
export function syntheticEmail(suite: string): string {
  const slug = suite.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  sequence += 1;
  return `${SYNTHETIC_MAILBOX}+${slug || "suite"}-${Date.now()}${sequence}@${SYNTHETIC_DOMAIN}`;
}

// The convention every synthetic-account address must match: a plus-alias of the
// monitored mailbox. Asserted by tests so a fabricated recipient cannot creep
// back in.
export const SYNTHETIC_EMAIL_PATTERN = /^silen\+[a-z0-9-]+-\d+@experientiallabs\.ai$/;
