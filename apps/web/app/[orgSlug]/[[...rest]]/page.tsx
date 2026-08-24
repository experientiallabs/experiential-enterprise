import { notFound, permanentRedirect, redirect } from "next/navigation";

import { findAuthorizedOrg } from "@/lib/active-org";
import { safeNextPath } from "@/lib/auth/redirects";
import { legacyQueryString } from "@/lib/legacy-query";
import { isReservedRouteSlug, reservedSlugRedirect } from "@/lib/routes";

type LegacyOrgPageProps = {
  params: Promise<{ orgSlug: string; rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Legacy /{orgSlug}/... URLs: workspace pages moved to the root, so the org
 * segment drops and the rest of the path redirects permanently, query intact
 * (deep links like /{org}/playground?model=x keep their selection). Unknown
 * first segments (stale bookmarks, typos) get the styled 404. The active org
 * itself is cookie-state (lib/active-org.ts); a page cannot write cookies, so
 * a multi-org deep link lands in the follower's active org, which is the
 * accepted tradeoff of the root scheme.
 */
export default async function LegacyOrgPage({ params, searchParams }: LegacyOrgPageProps) {
  const { orgSlug, rest } = await params;
  // A reserved route name reaching this catch-all is never an org slug: the
  // static route out-prioritizes [orgSlug], so we only land here for a slug
  // with no static route at this depth (e.g. bare /usage, or /telemetry/extra
  // past the static leaf). Resolve it as an app path rather than looking it up
  // as an org and following the org cookie -- that is the swallow hazard when a
  // new top-level slug is not registered. A bare reserved slug redirects to its
  // real page (/usage -> /credits); a reserved prefix with extra
  // segments, or one with no page, is a plain 404.
  if (isReservedRouteSlug(orgSlug)) {
    const target = reservedSlugRedirect(orgSlug);
    if (target !== null && (rest ?? []).length === 0) {
      redirect(target);
    }
    notFound();
  }
  const org = await findAuthorizedOrg(orgSlug);
  if (org === null) {
    notFound();
  }
  // The rest segments are attacker-influenceable path data; safeNextPath
  // collapses protocol-relative and backslash forms to the app root instead
  // of letting a crafted deep link 308 off-origin.
  const path = safeNextPath(`/${(rest ?? []).join("/")}`);
  permanentRedirect(`${path}${legacyQueryString(await searchParams)}`);
}
