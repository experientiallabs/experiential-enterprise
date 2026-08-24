import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The distinct provider identities ("email", "google", "github", ...) across
 * every non-deleted auth user that shares `email`, via the service-role
 * `signin_methods_for_email` definer lookup (service-role only — exposing it
 * wider would be an account-existence oracle).
 *
 * Null means "could not check" (missing service key, GoTrue hiccup); callers
 * must treat null as indistinguishable rather than as "no account", so a
 * transient internal failure never changes what a caller discloses or blocks.
 */
export async function signinMethodsForEmail(
  admin: Pick<SupabaseClient, "rpc">,
  email: string
): Promise<string[] | null> {
  try {
    const { data, error } = await admin.rpc("signin_methods_for_email", { check_email: email });
    if (error !== null || !Array.isArray(data)) {
      return null;
    }
    return data.filter((method): method is string => typeof method === "string");
  } catch {
    return null;
  }
}
