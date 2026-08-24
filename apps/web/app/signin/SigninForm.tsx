"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { AuthForm } from "@/components/auth/AuthForm";
import { hasYcIntent } from "@/components/yc/yc-intent";
import { safeNextPath } from "@/lib/auth/redirects";
import { overviewPath, overviewWelcomePath, ycSigninPath } from "@/lib/routes";

type SigninFormProps = {
  inviteToken: string | null;
  prefillEmail: string | null;
  /** The YC-deal variant: auth success stays on /signin?yc=1, whose signed-in render is the claim. */
  ycDeal?: boolean;
};

/**
 * The full-page /signin host: invite links, direct hits, and the /yc short
 * link — nothing in the app links here anymore (in-app gating opens the login
 * modal instead). A full-page login has no page to return to, so success
 * lands on the personal Overview unless an explicit ?next= deep link says
 * otherwise; a just-created account always starts at the Overview (it IS the
 * "here's your key and credits" destination — there is no onboarding flow).
 *
 * The YC variant instead stays put, for EVERY auth method: the yc param
 * rides the OAuth next target, and email-code successes refresh in place,
 * so either auth route re-renders this URL signed-in — the auto-claim
 * surface. The variant is derived from the URL as well as the prop, and the
 * generic success path honors the YC-intent cookie, so no single dropped
 * prop or redirect slip can bounce a YC signup to /overview unclaimed
 * (the product owner hit exactly that live when a fold restored the pre-YC form).
 */
export function SigninForm({ inviteToken, prefillEmail, ycDeal = false }: SigninFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isYcDeal = ycDeal || searchParams.get("yc") === "1";
  const isCodeSignup = searchParams.get("signup") === "1";
  const next = safeNextPath(searchParams.get("next"));
  // safeNextPath collapses absent/foreign targets to "/", which for a
  // signed-in user only re-forks to the Overview; land there in one hop.
  const target = next === "/" ? overviewPath() : next;
  // The /signup handler bounces an EXISTING account here with ?sent=1 after
  // emailing a sign-in code, so open straight on the code-entry stage.
  const initialCodeSentTo = searchParams.get("sent") === "1" ? prefillEmail : null;

  return (
    <AuthForm
      inviteToken={inviteToken}
      prefillEmail={prefillEmail}
      tone="dark"
      oauthNext={isYcDeal ? ycSigninPath() : target}
      initialErrorCode={searchParams.get("error")}
      initialCodeSentTo={initialCodeSentTo}
      // Trusted funnels already collected the email to sign the visitor in,
      // so send the code and open the code stage for them. A plain prefilled
      // invite link must not: it would email a code to an address the visitor
      // never typed on this origin.
      autoSendCode={
        isYcDeal && prefillEmail !== null && initialCodeSentTo === null
      }
      onSuccess={({ created }) => {
        if (isYcDeal) {
          router.refresh();
          return;
        }
        // A login that started from the YC link but resolved here (marker
        // still set) belongs on the claim surface, not the Overview.
        if (hasYcIntent()) {
          router.push(ycSigninPath());
          router.refresh();
          return;
        }
        router.push(
          created && isCodeSignup ? overviewWelcomePath() : created ? overviewPath() : target
        );
        router.refresh();
      }}
    />
  );
}
