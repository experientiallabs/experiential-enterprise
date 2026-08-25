import Link from "next/link";

import { DeleteAccountCard } from "@/components/settings/DangerZone";
import { PasswordChangeForm } from "@/components/settings/PasswordChangeForm";
import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import {
  canChangePasswordForSession,
  emailHasPassword,
  hasPasswordIdentity
} from "@/lib/auth/password";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { privacyPath, securityPath, termsPath } from "@/lib/routes";

export const metadata = { title: "Account" };

export const dynamic = "force-dynamic";

/** Account-scoped settings: these follow the signed-in user, not the org. */
export default async function AccountSettingsPage() {
  // Settings is workspace-private (main's proxy bounces signed-out to /signin).
  const user = await requireAuthenticatedUser();
  const passwordSection = await currentUserPasswordSection();

  return (
    <div className="flex flex-col gap-5">
      <section className="border border-line rounded-lg bg-surface p-[18px]">
        <div className="grid gap-[18px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.45fr)]">
          <div>
            <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Your account
            </p>
            <h2 className="m-0 mt-2 text-ink text-[15px] font-semibold tracking-tight">
              Password
            </h2>
            <p className="m-0 mt-2 max-w-[360px] text-muted text-[13px] leading-relaxed">
              {passwordSection === "set"
                ? "Your account signs in with an emailed code and has no password. Set one if you also want a password login. The emailed code keeps working either way."
                : "Update the password for your signed-in account. This applies to you across every organization you belong to. You'll stay signed in after the change."}
            </p>
          </div>
          {passwordSection === "notice" ? (
            <PasswordIdentityNotice />
          ) : (
            <PasswordChangeForm mode={passwordSection} />
          )}
        </div>
      </section>
      <section className="border border-line rounded-lg bg-surface p-[18px]">
        <div className="grid gap-[18px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.45fr)]">
          <div>
            <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Legal
            </p>
            <h2 className="m-0 mt-2 text-ink text-[15px] font-semibold tracking-tight">
              Policies
            </h2>
            <p className="m-0 mt-2 max-w-[360px] text-muted text-[13px] leading-relaxed">
              How your data is handled and the terms you use the platform under.
            </p>
          </div>
          <div className="flex items-center gap-4 text-[13px]">
            <Link className="text-ink underline hover:no-underline" href={privacyPath()}>
              Privacy policy
            </Link>
            <Link className="text-ink underline hover:no-underline" href={termsPath()}>
              Terms of service
            </Link>
            <Link className="text-ink underline hover:no-underline" href={securityPath()}>
              Security &amp; reliability
            </Link>
          </div>
        </div>
      </section>
      <DeleteAccountCard email={user.email ?? ""} />
    </div>
  );
}

/**
 * `change` proves the current password; `set` is the first password for a
 * passwordless email-code account (verified against the service-role
 * password lookup, failing closed to the notice); `notice` covers OAuth-only
 * sessions and anything unverifiable.
 */
async function currentUserPasswordSection(): Promise<"change" | "set" | "notice"> {
  const supabase = await createServerSupabaseClient();
  const [claimsResult, userResult] = await Promise.all([
    supabase.auth.getClaims(),
    supabase.auth.getUser()
  ]);
  if (claimsResult.error || userResult.error) {
    return "notice";
  }
  const authUser = userResult.data.user;
  if (canChangePasswordForSession(authUser, claimsResult.data?.claims)) {
    return "change";
  }
  if (!hasPasswordIdentity(authUser) || typeof authUser?.email !== "string") {
    return "notice";
  }
  try {
    const hasPassword = await emailHasPassword(createServiceRoleSupabaseClient(), authUser.email);
    return hasPassword === false ? "set" : "notice";
  } catch {
    return "notice";
  }
}

function PasswordIdentityNotice() {
  return (
    <div className="rounded-[var(--radius-md)] border border-line-strong bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-muted">
      Password changes are available after signing in with an email and password.
    </div>
  );
}
