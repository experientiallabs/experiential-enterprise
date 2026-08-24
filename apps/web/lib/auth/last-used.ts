// Client-side memory of the auth method that last signed this browser in,
// backing the "Last used" badge on /signin. localStorage is the right scope:
// the hint belongs to the device, not the account (there is no session yet
// when it renders), and losing it costs nothing but the badge.

export type AuthMethod = "google" | "github" | "password" | "email_code";

const STORAGE_KEY = "explabs.last-auth-method";
const AUTH_METHODS: readonly AuthMethod[] = ["google", "github", "password", "email_code"];

export function readLastAuthMethod(): AuthMethod | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return AUTH_METHODS.includes(value as AuthMethod) ? (value as AuthMethod) : null;
  } catch {
    // Storage access can throw (disabled cookies, private modes); no badge then.
    return null;
  }
}

export function recordAuthMethod(method: AuthMethod): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, method);
  } catch {
    // Best effort: sign-in must not depend on storage being writable.
  }
}
