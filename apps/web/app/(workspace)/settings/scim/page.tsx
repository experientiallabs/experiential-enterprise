import { notFound } from "next/navigation";

import { ScimTokenSection } from "@/components/settings/ScimTokenSection";
import { publicServingBaseUrl } from "@/components/world-models/endpoint-snippets";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getOrgCapability } from "@/lib/capabilities";

export const metadata = { title: "SCIM provisioning" };

export const dynamic = "force-dynamic";

export default async function ScimSettingsPage() {
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();

  // Enterprise gate (/ee): without the scim capability the surface does not
  // exist — a plain 404, no upsell chrome (product decision).
  if ((await getOrgCapability(org.id, "scim")) !== "available") {
    notFound();
  }

  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));

  // Token management is an admin surface end to end (the backend requires
  // org admin), so a non-admin sees the explanation, not a failed fetch —
  // same treatment as the audit log page.
  if (!canManage) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="m-0 text-ink text-base font-semibold">SCIM provisioning</h2>
          <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
            SCIM provisioning is managed by organization admins. Ask an admin if your
            identity provider should manage membership of this organization.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="m-0 text-ink text-base font-semibold">SCIM provisioning</h2>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Let your identity provider create and remove members of this organization
          automatically. Deprovisioning removes the member and, per your policy, revokes
          the API keys they created, their accounts and other organizations are untouched.
        </p>
      </div>
      <ScimTokenSection orgId={org.id} scimBaseUrl={`${publicServingBaseUrl()}/scim/v2`} />
    </div>
  );
}
