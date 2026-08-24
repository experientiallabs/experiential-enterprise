// Pure address normalization shared by the admin email-edit client dialog and
// its route handler, so the two cannot drift on what counts as a valid email.

export const MAX_EMAIL_LENGTH = 320;

/**
 * The trimmed, lowercased email, or null when the input is not a plausible
 * address (empty, over-long, missing "@", or containing whitespace). This is
 * deliberately shallow: GoTrue's own validation is the authority, this just
 * refuses obvious garbage before a round trip.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > MAX_EMAIL_LENGTH ||
    !email.includes("@") ||
    /\s/.test(email)
  ) {
    return null;
  }
  return email;
}
