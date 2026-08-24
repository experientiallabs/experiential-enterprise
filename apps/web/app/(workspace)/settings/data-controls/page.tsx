import { notFound } from "next/navigation";

import { ProviderPolicyPanel } from "@/components/settings/ProviderPolicyPanel";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getOrgCapability } from "@/lib/capabilities";

export const metadata = { title: "Provider policy" };

export const dynamic = "force-dynamic";

export default async function DataControlsPage() {
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();

  // Enterprise gate (/ee): without the data_controls capability the surface
  // does not exist — a plain 404, no upsell chrome (product decision). The
  // gate covers MANAGEMENT only; the gateway worker enforces an already
  // written policy regardless of licensing.
  if ((await getOrgCapability(org.id, "data_controls")) !== "available") {
    notFound();
  }

  // Reading the policy is member-strength (the backend admits USER role);
  // writing and removing it are admin-only, so members get the same panel
  // without the management controls.
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="m-0 text-ink text-base font-semibold">Provider policy</h2>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Restrict which providers may serve this organization&apos;s traffic and require
          zero-data-retention or no-training postures. Posture flags reflect each provider&apos;s
          documented API defaults — not customer-specific agreements.
        </p>
      </div>
      <ProviderPolicyPanel orgId={org.id} canManage={canManage} />
    </div>
  );
}
