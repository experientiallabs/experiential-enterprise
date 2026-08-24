"use client";

import { useEffect } from "react";

import type { AuthenticatedUser } from "@/lib/auth/claims";
import { syncTelemetryIdentity, type TelemetryOrg } from "@/lib/telemetry/client";

type PostHogIdentityProps = {
  user: AuthenticatedUser | null;
  org: TelemetryOrg | null;
};

/**
 * Client bridge that mirrors the server-verified user into the PostHog
 * session. The root layout re-renders on router.refresh() after login and
 * sign-out (and on any navigation once a session expires), so both the
 * identify and the identified→anonymous reset flow through here. The active
 * org rides along when the server resolved one, enriching the person with
 * org_slug/org_name. Renders nothing.
 */
export function PostHogIdentity({ user, org }: PostHogIdentityProps) {
  const userId = user?.id ?? null;
  const email = user?.email ?? null;
  const orgSlug = org?.slug ?? null;
  const orgName = org?.name ?? null;
  useEffect(() => {
    syncTelemetryIdentity(
      userId ? { id: userId, email } : null,
      orgSlug !== null && orgName !== null ? { slug: orgSlug, name: orgName } : null
    );
  }, [userId, email, orgSlug, orgName]);
  return null;
}
