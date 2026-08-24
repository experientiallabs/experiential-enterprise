import { notFound } from "next/navigation";

import { AuditLogPanel } from "@/components/settings/AuditLogPanel";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getOrgCapability } from "@/lib/capabilities";

export const metadata = { title: "Audit log" };

export const dynamic = "force-dynamic";

export default async function AuditLogPage() {
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();

  // Enterprise gate (/ee): without the audit_log capability the surface does
  // not exist — a plain 404, no upsell chrome (product decision).
  if ((await getOrgCapability(org.id, "audit_log")) !== "available") {
    notFound();
  }

  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));

  // The audit trail is an admin surface end to end (the backend requires org
  // admin to even list it), so a non-admin sees the explanation, not a
  // failed fetch — same treatment as the aliases page.
  if (!canManage) {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="m-0 text-ink text-base font-semibold">Audit log</h2>
          <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
            The audit log is available to organization admins. Ask an admin if you need a record
            of administrative activity in this organization.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="m-0 text-ink text-base font-semibold">Audit log</h2>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Administrative activity in this organization: API key lifecycle, membership and invite
          changes, billing settings, and data deletion — who did what, and when.
        </p>
      </div>
      <AuditLogPanel orgId={org.id} />
    </div>
  );
}
