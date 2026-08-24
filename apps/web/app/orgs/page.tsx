import { OrgsGrid } from "@/components/orgs/OrgsGrid";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { filterAuthorizedOrgs, requireAuthorizedOrgIds } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";

export const metadata = { title: "Organizations" };

export const dynamic = "force-dynamic";

/**
 * Every signed-in member sees and switches between THEIR organizations here
 * (enterprise build-out, superseding the 2026-08-01 operator-only gate);
 * platform admins keep seeing all organizations, and creating new ones stays
 * a platform-admin move. A memberless session still gets the empty state
 * (the active-org resolver redirects here when no org resolves, so bouncing
 * that case would loop).
 */
export default async function OrgsPage() {
  const [authorizedOrgIds, platformAdmin] = await Promise.all([
    requireAuthorizedOrgIds(),
    isPlatformAdmin()
  ]);
  const orgs = filterAuthorizedOrgs(await getDataSource().listOrgs(), authorizedOrgIds);
  return <OrgsGrid canCreate={platformAdmin} orgs={orgs} />;
}
