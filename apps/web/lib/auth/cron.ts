import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of a machine caller's `Authorization: Bearer
 * <CRON_SECRET>`. The scheme is matched case-insensitively and the credential
 * trimmed, per RFC 6750's tolerance for both. A deployment without
 * CRON_SECRET fails closed. Internal machine routes share this so the
 * verify-then-service-role shape stays uniform.
 */
export function bearerMatchesCronSecret(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  const match = header?.match(/^bearer\s+(.+)$/i);
  if (!secret || !match) {
    return false;
  }
  // Hashing both sides keeps the compare constant-time across lengths.
  const presented = createHash("sha256").update(match[1].trim()).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(presented, expected);
}
