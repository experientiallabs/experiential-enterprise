import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export const PASSWORD_RECOVERY_COOKIE = "explabs-password-recovery";
export const PASSWORD_RECOVERY_TTL_SECONDS = 60 * 60;

type RecoverySessionIdentity = {
  userId: string;
  sessionId: string;
};

export function recoverySessionIdentity(claims: unknown): RecoverySessionIdentity | null {
  if (typeof claims !== "object" || claims === null) {
    return null;
  }
  const { sub, session_id: sessionId } = claims as {
    sub?: unknown;
    session_id?: unknown;
  };
  if (typeof sub !== "string" || typeof sessionId !== "string") {
    return null;
  }
  return { userId: sub, sessionId };
}

export function sessionIdFromAccessToken(accessToken: string | null | undefined): string | null {
  if (typeof accessToken !== "string") {
    return null;
  }
  const payload = accessToken.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return recoverySessionIdentity(claims)?.sessionId ?? null;
  } catch {
    return null;
  }
}

export function createPasswordRecoveryTicket(
  identity: RecoverySessionIdentity,
  now = Date.now()
): string {
  const expiresAt = Math.floor(now / 1000) + PASSWORD_RECOVERY_TTL_SECONDS;
  return `${expiresAt}.${signTicket(identity, expiresAt)}`;
}

export function verifyPasswordRecoveryTicket(
  ticket: string | null | undefined,
  identity: RecoverySessionIdentity,
  now = Date.now()
): boolean {
  if (typeof ticket !== "string") {
    return false;
  }
  const [rawExpiresAt, signature, extra] = ticket.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (
    extra !== undefined ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(now / 1000)
  ) {
    return false;
  }
  const expected = Buffer.from(signTicket(identity, expiresAt), "base64url");
  const presented = Buffer.from(signature ?? "", "base64url");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

export function passwordRecoveryCookieOptions() {
  return {
    httpOnly: true,
    maxAge: PASSWORD_RECOVERY_TTL_SECONDS,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production"
  };
}

function signTicket(identity: RecoverySessionIdentity, expiresAt: number): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set for password recovery.");
  }
  return createHmac("sha256", secret)
    .update(`password-recovery:${identity.userId}:${identity.sessionId}:${expiresAt}`)
    .digest("base64url");
}
