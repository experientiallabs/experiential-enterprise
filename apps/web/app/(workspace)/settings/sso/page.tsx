import { notFound } from "next/navigation";

import { DomainsSsoPanel } from "@/components/settings/DomainsSsoPanel";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getOrgCapability } from "@/lib/capabilities";

export const metadata = { title: "Domains & SSO" };

export const dynamic = "force-dynamic";

export default async function DomainsSsoPage() {
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();

  // Enterprise gate (/ee): without the sso capability the surface does not
  // exist — a plain 404, no upsell chrome (product decision).
  if ((await getOrgCapability(org.id, "sso")) !== "available") {
    notFound();
  }

  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));

  // Domain verification and IdP registration decide who can reach the org at
  // all, so this is an admin surface end to end (the backend requires org
  // admin to even list it) — same treatment as the audit log page.
  if (!canManage) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="m-0 text-ink text-base font-semibold">Domains &amp; SSO</h2>
          <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
            Domain verification and single sign-on are managed by organization admins. Ask an
            admin if your organization&apos;s sign-in requirements need to change.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="m-0 text-ink text-base font-semibold">Domains &amp; SSO</h2>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Verify the domains your organization owns, register its identity provider, and require
          single sign-on for members. Requiring SSO binds at organization access: sessions signed
          in another way are asked to step up through the identity provider.
        </p>
      </div>
      <DomainsSsoPanel orgId={org.id} />
    </div>
  );
}
