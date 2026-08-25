import { Suspense } from "react";

import { BrandMark } from "@/components/brand/BrandMark";
import { ContributionGrid } from "@/components/onboarding/ContributionGrid";
import { YCombinatorMark } from "@/components/yc/YCombinatorMark";
import { YcArrivalCapture } from "@/components/yc/YcArrivalCapture";
import { YcClaimRedirect } from "@/components/yc/YcClaimRedirect";
import { safePrefillEmail } from "@/lib/auth/redirects";
import { createServerSupabaseClient, getAuthenticatedUser } from "@/lib/auth/server";

import { SigninForm } from "./SigninForm";

export const metadata = { title: "Sign in" };

export const dynamic = "force-dynamic";

type SigninPageProps = {
  searchParams: Promise<{ invite?: string; yc?: string; email?: string; sso_required?: string }>;
};

type InvitePrefill = {
  email: string | null;
  orgName: string | null;
  invitedRole: string | null;
};

// Resolves an invite link's token through the anon-callable definer RPC. The
// lookup only prefills the form: an unknown, expired, or consumed token (or
// an RPC failure) renders the plain sign-in form rather than an error page,
// because the invite (if any) is matched again by token inside the signup
// provisioning trigger, which is the authority.
async function lookupInvite(token: string): Promise<InvitePrefill | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("lookup_org_invitation", { invite_token: token });
  if (error) {
    console.error(`Invite prefill lookup failed (rendering plain sign-in): ${error.message}`);
    return null;
  }
  const row = (
    data as { email?: unknown; org_name?: unknown; invited_role?: unknown }[] | null
  )?.[0];
  if (!row) {
    return null;
  }
  return {
    email: typeof row.email === "string" ? row.email : null,
    orgName: typeof row.org_name === "string" ? row.org_name : null,
    invitedRole: typeof row.invited_role === "string" ? row.invited_role : null
  };
}

// The step-up landing (E2): only when the org's provider row exists AND is
// enabled does the sign-in button render — through the authenticated-only
// definer RPC, so a signed-out visitor (or an unknown slug) gets the neutral
// copy alone. A lookup failure renders the copy without the button rather
// than an error page; the requirement is explained either way.
async function lookupSsoSignin(orgSlug: string): Promise<{ domain: string } | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("org_sso_signin_provider", { in_slug: orgSlug });
  if (error) {
    return null;
  }
  const row = (data as { domain?: unknown }[] | null)?.[0];
  return typeof row?.domain === "string" ? { domain: row.domain } : null;
}

export default async function SigninPage({ searchParams }: SigninPageProps) {
  const { invite, yc, email, sso_required: ssoRequiredOrg } = await searchParams;
  // The marketing site collects only an email and continues here prefilled;
  // credentials are typed on this origin alone. Malformed values are ignored,
  // and an invite's own address (bound to the token) outranks the param.
  const prefillEmailParam = safePrefillEmail(email ?? null);
  if (yc === "1") {
    return <YcDealPage prefillEmail={prefillEmailParam} />;
  }
  const prefill = invite ? await lookupInvite(invite) : null;
  const ssoSignin = ssoRequiredOrg ? await lookupSsoSignin(ssoRequiredOrg) : null;
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
            Sign in
          </h1>
          {prefill?.orgName ? (
            <p className="text-sm text-onboard-muted">
              {`You've been invited to join ${prefill.orgName}${
                prefill.invitedRole ? ` as ${prefill.invitedRole}` : ""
              }.`}
            </p>
          ) : null}
          {ssoRequiredOrg ? (
            <p className="text-sm text-onboard-muted">
              This organization requires single sign-on.
            </p>
          ) : null}
        </div>

        {ssoRequiredOrg && ssoSignin ? (
          <a
            className="mb-6 flex w-full items-center justify-center rounded-lg border border-onboard-muted/40 px-4 py-2.5 text-sm font-medium text-onboard-text no-underline hover:border-onboard-muted"
            href={`/auth/sso?org=${encodeURIComponent(ssoRequiredOrg)}`}
          >
            Continue with single sign-on
          </a>
        ) : null}

        <Suspense>
          <SigninForm
            inviteToken={invite ?? null}
            prefillEmail={prefill?.email ?? prefillEmailParam}
          />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * The YC-deal variant of /signin (the /yc short link lands here). Signed out:
 * the co-branded header, one line of the offer, and the same AuthForm — a
 * login here IS the claim, so the form threads the yc param through both auth
 * paths. Signed in: YcClaimRedirect applies the claim and drops the founder
 * into the app, where the welcome modal greets them. There is no other YC page.
 */
async function YcDealPage({ prefillEmail }: { prefillEmail: string | null }) {
  const user = await getAuthenticatedUser();
  const signedIn = user !== null;
  // Signed out is the dark co-branded pitch; the signed-in surface is light by
  // default (round-3), so the paste-the-prompt CTA reads as the product, not a
  // marketing splash. The header tokens flip with it.
  return (
    <div
      className={`relative min-h-screen flex items-center justify-center overflow-hidden ${
        signedIn ? "bg-background py-8" : "bg-onboard-bg py-12"
      }`}
    >
      <ContributionGrid className="absolute inset-0 w-full h-full opacity-40" />
      <YcArrivalCapture signedIn={signedIn} />

      <div className={`relative z-10 w-full ${signedIn ? "max-w-[680px]" : "max-w-[440px]"} px-6`}>
        <div className={`text-center ${signedIn ? "mb-6" : "mb-10"}`}>
          <div className={`inline-flex items-center gap-3 ${signedIn ? "mb-4" : "mb-6"}`}>
            <div
              className={`w-11 h-11 rounded-xl flex items-center justify-center ${
                signedIn ? "bg-ink" : "bg-onboard-text"
              }`}
            >
              <BrandMark className={`w-7 h-7 ${signedIn ? "text-surface" : "text-onboard-bg"}`} />
            </div>
            <span aria-hidden className={`text-lg ${signedIn ? "text-muted-2" : "text-onboard-muted"}`}>
              ×
            </span>
            <YCombinatorMark className="w-11 h-11 rounded-xl" />
          </div>
          <h1
            className={`text-[28px] font-semibold tracking-tight mb-2 ${
              signedIn ? "text-ink" : "text-onboard-text"
            }`}
          >
            {signedIn ? "You're in" : "The S26 deal"}
          </h1>
          <p
            className={`text-sm leading-relaxed ${signedIn ? "text-muted" : "text-onboard-muted"}`}
          >
            {signedIn
              ? "Applying your YC deal and opening your workspace."
              : "$526 in model credits for YC companies. Every model behind one OpenAI-compatible endpoint at exact provider cost, no markup, and your own provider keys ride free. Sign in and the credits are yours; your coding agent does the rest."}
          </p>
        </div>

        {signedIn ? (
          <YcClaimRedirect />
        ) : (
          <Suspense>
            <SigninForm inviteToken={null} prefillEmail={prefillEmail} ycDeal />
          </Suspense>
        )}
      </div>
    </div>
  );
}
