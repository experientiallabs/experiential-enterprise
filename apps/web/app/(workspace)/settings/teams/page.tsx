import { notFound } from "next/navigation";

import { TeamsPanel } from "@/components/settings/TeamsPanel";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getOrgCapability } from "@/lib/capabilities";

export const metadata = { title: "Teams" };

export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();

  // Enterprise gate (/ee): without the teams capability the surface does not
  // exist — a plain 404, no upsell chrome (product decision).
  if ((await getOrgCapability(org.id, "teams")) !== "available") {
    notFound();
  }

  // Reading the team list is member-strength (the backend admits USER role);
  // creating, renaming, deleting, and assignment are admin-only, so members
  // get the same panel without the management controls.
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="m-0 text-ink text-base font-semibold">Teams</h2>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Group members and attribute API keys to teams. Team-scoped budgets and per-team usage
          reporting build on these assignments.
        </p>
      </div>
      <TeamsPanel orgId={org.id} canManage={canManage} />
    </div>
  );
}
