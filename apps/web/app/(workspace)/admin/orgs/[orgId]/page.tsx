import { notFound } from "next/navigation";

import { OrgAdminDetail } from "@/components/admin/OrgAdminDetail";
import { getAdministeredOrg } from "@/lib/admin/orgs-server";
import { requireAuthenticatedUser } from "@/lib/auth/server";

export const metadata = { title: "Organization" };

export const dynamic = "force-dynamic";

/**
 * One organization's admin detail: the click-through target from the admin
 * Organizations cards. The (workspace)/admin layout above gates the whole
 * segment to platform operators, so this page renders only after that check.
 */
export default async function AdminOrgDetailPage({
  params
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const [user, org] = await Promise.all([requireAuthenticatedUser(), getAdministeredOrg(orgId)]);
  if (!org) {
    notFound();
  }
  return <OrgAdminDetail currentUserId={user.id} org={org} />;
}
