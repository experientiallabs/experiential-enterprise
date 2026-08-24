import { BrandMark } from "@/components/brand/BrandMark";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { ContributionGrid } from "@/components/onboarding/ContributionGrid";

export const metadata = { title: "Set a new password" };

export const dynamic = "force-dynamic";

/**
 * The landing point after the emailed password-recovery link runs through
 * /auth/callback (which seats the short recovery session). The set-password form
 * updates the credential on that session; anyone without a recovery session is
 * bounced to /signin by the proxy (this route is not in the public allowlist).
 */
export default function ResetPasswordPage() {
  return (
    <div className="relative min-h-screen bg-onboard-bg flex items-center justify-center overflow-hidden">
      <ContributionGrid className="absolute inset-0 w-full h-full opacity-40" />

      <div className="relative z-10 w-full max-w-[400px] px-6">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-6">
            <div className="w-11 h-11 bg-onboard-text rounded-xl flex items-center justify-center">
              <BrandMark className="w-7 h-7 text-onboard-bg" />
            </div>
            <span className="text-[15px] font-semibold text-onboard-muted tracking-[0.18em] uppercase font-mono">
              Experiential
            </span>
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-onboard-text mb-2">
            Set a new password
          </h1>
          <p className="text-sm text-onboard-muted">
            Choose a password for your account. You can still sign in with an emailed code anytime.
          </p>
        </div>

        <ResetPasswordForm />
      </div>
    </div>
  );
}
