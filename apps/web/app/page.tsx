import { redirect } from "next/navigation";

import { requireAuthorizedOrgIds } from "@/lib/auth/orgs";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { modelsPath, orgsPath, overviewPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // "/" resolves per audience: a signed-out visitor gets the public model
  // catalog, a member lands on their personal Overview. There is no first-run
  // onboarding gate anymore — the Overview IS the "here's your key and
  // credits" destination.
  const user = await getAuthenticatedUser();
  if (user === null) {
    redirect(modelsPath());
  }
  // Memberless sessions fall through to the /orgs empty state instead of an
  // Overview with no workspace behind it.
  const authorizedOrgIds = await requireAuthorizedOrgIds();
  if (authorizedOrgIds.size === 0) {
    redirect(orgsPath());
  }
  redirect(overviewPath());
}
