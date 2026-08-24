// Which OAuth providers this deployment can actually sign in with, read from
// GoTrue's public settings endpoint. Consumed by the /auth/oauth route: the
// sign-in page renders every provider button unconditionally (the product owner,
// 2026-07-30), and a click on one GoTrue has no credentials for comes back
// as the readable provider_disabled message instead of a broken dance.

import { loadSupabaseAuthSettings } from "./config";

export const OAUTH_PROVIDERS = ["github", "google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The subset of OAUTH_PROVIDERS GoTrue reports enabled, or null when the
 * check cannot run (unreachable or slow GoTrue). Callers must treat null as
 * "unknown" and proceed, the /auth/oauth route redirects anyway and lets
 * the browser's own navigation surface GoTrue's error. This settings read is
 * deliberately an apikey'd JSON call: probing the authorize URL bare from
 * the server pod is answered differently than a browser navigation by hosted
 * Supabase's edge, which is how a fully configured staging once reported its
 * providers as disabled.
 */
export async function enabledOAuthProviders(): Promise<OAuthProvider[] | null> {
  try {
    const settings = loadSupabaseAuthSettings();
    const base = settings.url.replace(/\/+$/, "");
    // Bounded probe: a slow GoTrue must not stall the sign-in page render.
    const response = await fetch(`${base}/auth/v1/settings`, {
      cache: "no-store",
      headers: { apikey: settings.anonKey },
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { external?: Record<string, unknown> };
    const external = payload.external;
    if (external === undefined || external === null || typeof external !== "object") {
      return null;
    }
    return OAUTH_PROVIDERS.filter((provider) => external[provider] === true);
  } catch {
    return null;
  }
}
