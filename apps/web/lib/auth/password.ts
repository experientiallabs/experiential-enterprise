import type { SupabaseClient } from "@supabase/supabase-js";

export type ChangePasswordPayload = {
  /**
   * Null on a first-password set: email-code accounts are passwordless by
   * default and have no current credential to prove — the session is the
   * proof. The route only honors null for an account that verifiably has no
   * password; every existing password still requires its predecessor.
   */
  currentPassword: string | null;
  newPassword: string;
  confirmPassword: string;
};

/**
 * Whether the address's account carries a password credential, via the
 * service-role `email_has_password` definer lookup. Null means "could not
 * check" — callers degrade to their password-required behavior rather than
 * treating the account as passwordless.
 */
export async function emailHasPassword(
  admin: Pick<SupabaseClient, "rpc">,
  email: string
): Promise<boolean | null> {
  try {
    const { data, error } = await admin.rpc("email_has_password", { check_email: email });
    if (error !== null || typeof data !== "boolean") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

type PasswordIdentityUser = {
  app_metadata?: {
    provider?: unknown;
    providers?: unknown;
  };
  identities?: Array<{
    provider?: unknown;
  }>;
};

type PasswordIdentityClaims = {
  amr?: unknown;
};

export const MIN_PASSWORD_LENGTH = 6;
const PASSWORD_PROVIDER = "email";
const PASSWORD_AUTH_METHOD = "password";
const RECOVERY_AUTH_METHODS = new Set(["magiclink", "otp", "recovery"]);

export function parseChangePasswordPayload(value: unknown): ChangePasswordPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Password change request must be an object.");
  }

  const payload = value as Record<string, unknown>;
  const rawCurrent = payload.currentPassword;
  const newPassword = payload.newPassword;
  const confirmPassword = payload.confirmPassword;

  if (rawCurrent !== undefined && rawCurrent !== null && typeof rawCurrent !== "string") {
    throw new Error("Current password must be a string.");
  }
  const currentPassword =
    typeof rawCurrent === "string" && rawCurrent.length > 0 ? rawCurrent : null;
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (typeof confirmPassword !== "string" || confirmPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password confirmation must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (newPassword !== confirmPassword) {
    throw new Error("New password and confirmation must match.");
  }
  if (currentPassword !== null && newPassword === currentPassword) {
    throw new Error("New password must be different from your current password.");
  }

  return { currentPassword, newPassword, confirmPassword };
}

export function hasPasswordIdentity(user: PasswordIdentityUser | null | undefined): boolean {
  if (!user) {
    return false;
  }

  const providers = new Set<string>();
  if (typeof user.app_metadata?.provider === "string") {
    providers.add(user.app_metadata.provider);
  }
  if (Array.isArray(user.app_metadata?.providers)) {
    user.app_metadata.providers.forEach((provider) => {
      if (typeof provider === "string") {
        providers.add(provider);
      }
    });
  }
  user.identities?.forEach((identity) => {
    if (typeof identity.provider === "string") {
      providers.add(identity.provider);
    }
  });

  return providers.has(PASSWORD_PROVIDER);
}

export function hasPasswordAuthMethod(
  claims: PasswordIdentityClaims | null | undefined
): boolean {
  if (!claims || !Array.isArray(claims.amr)) {
    return false;
  }

  return claims.amr.some((entry) => {
    if (entry === PASSWORD_AUTH_METHOD) {
      return true;
    }
    if (typeof entry === "object" && entry !== null && "method" in entry) {
      return (entry as { method?: unknown }).method === PASSWORD_AUTH_METHOD;
    }
    return false;
  });
}

export function canChangePasswordForSession(
  user: PasswordIdentityUser | null | undefined,
  claims: PasswordIdentityClaims | null | undefined
): boolean {
  return hasPasswordIdentity(user) && hasPasswordAuthMethod(claims);
}

/**
 * Whether GoTrue records an email-link authentication method compatible with a
 * recovery exchange. The reset route also requires a signed, session-bound
 * callback ticket because GoTrue reports admin-generated recovery links as
 * `otp` in some versions, which is not unique to password recovery.
 */
export function hasRecoveryAuthMethod(
  claims: PasswordIdentityClaims | null | undefined
): boolean {
  if (!claims || !Array.isArray(claims.amr)) {
    return false;
  }

  return claims.amr.some((entry) => {
    if (typeof entry === "string" && RECOVERY_AUTH_METHODS.has(entry)) {
      return true;
    }
    if (typeof entry === "object" && entry !== null && "method" in entry) {
      const method = (entry as { method?: unknown }).method;
      return typeof method === "string" && RECOVERY_AUTH_METHODS.has(method);
    }
    return false;
  });
}

/** Validate a new-password payload for the recovery set-password route. */
export function parseResetPassword(value: unknown): { password: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request must be an object.");
  }
  const password = (value as { password?: unknown }).password;
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return { password };
}
