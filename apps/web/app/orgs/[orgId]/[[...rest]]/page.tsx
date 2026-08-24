import { notFound, permanentRedirect } from "next/navigation";

import { findAuthorizedOrg } from "@/lib/active-org";
import { safeNextPath } from "@/lib/auth/redirects";
import { legacyQueryString } from "@/lib/legacy-query";

type LegacyOrgPageProps = {
  params: Promise<{ orgId: string; rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Legacy /orgs/{uuid-or-slug}/... URLs (bookmarks, seeded links): workspace
 * pages moved to the root, so the org segment drops and the rest of the path
 * redirects permanently, query intact. Unknown ids (stale bookmarks, typos)
 * get the styled 404. The active org is cookie-state (lib/active-org.ts); a
 * page cannot write cookies, so a multi-org deep link lands in the follower's
 * active org, which is the accepted tradeoff of the root scheme. /orgs itself
 * (no id) is the org index and is served by its own page.
 */
export default async function LegacyOrgPage({ params, searchParams }: LegacyOrgPageProps) {
  const { orgId, rest } = await params;
  const org = await findAuthorizedOrg(orgId);
  if (org === null) {
    notFound();
  }
  // The rest segments are attacker-influenceable path data; safeNextPath
  // collapses protocol-relative and backslash forms to the app root instead
  // of letting a crafted deep link 308 off-origin.
  const path = safeNextPath(`/${(rest ?? []).join("/")}`);
  permanentRedirect(`${path}${legacyQueryString(await searchParams)}`);
}
