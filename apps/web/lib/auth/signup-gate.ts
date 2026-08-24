import type { SupabaseClient } from "@supabase/supabase-js";

export const SIGNUP_DISABLED_MESSAGE =
  "Account creation is currently disabled. Ask an administrator for an invite.";

// Signups are allowed when the platform-wide app_settings.signups_enabled
// flag is on, or when the signup carries a live invite-link token. The token
// is the only proof of inbox ownership (it was delivered to the invited
// address); a bare signup email is NOT, because email confirmation is
// disabled. Matching an invite on email alone would let anyone who knows an
// invited address create that account and be provisioned the invitee's
// membership, so it is deliberately not accepted here. Runs on the
// service-role client: neither table is readable by anon, and this check
// happens before a session exists.
export async function isSignupAllowed(
  admin: SupabaseClient,
  _email: string,
  inviteToken: string | null = null
): Promise<boolean> {
  const { data: settings, error: settingsError } = await admin
    .from("app_settings")
    .select("signups_enabled")
    .maybeSingle();
  if (settingsError) {
    throw new Error(`Unable to read signup settings: ${settingsError.message}`);
  }
  if (settings?.signups_enabled) {
    return true;
  }

  if (!inviteToken) {
    return false;
  }

  const { count, error } = await admin
    .from("org_invitations")
    .select("id", { count: "exact", head: true })
    .eq("token", inviteToken)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (error) {
    throw new Error(`Unable to check invites: ${error.message}`);
  }
  return (count ?? 0) > 0;
}
