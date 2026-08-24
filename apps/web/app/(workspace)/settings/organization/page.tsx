import { formatCostUsd, formatSignedCostUsd } from "@/lib/money";
import { DeleteOrgDataCard } from "@/components/settings/DangerZone";
import { OrgNameForm } from "@/components/settings/OrgNameForm";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { resolveActiveOrg } from "@/lib/active-org";
import { requireAuthenticatedUser } from "@/lib/auth/server";

export const metadata = { title: "Organization" };

export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage() {
  // Settings is workspace-private (main's proxy bounces signed-out to /signin).
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));

  return (
    <div className="flex flex-col gap-5">
      <section className="border border-line rounded-lg bg-surface p-[18px]">
        <div className="grid gap-[18px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.45fr)]">
          <div>
            <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Identity
            </p>
            <h2 className="m-0 mt-2 text-ink text-[15px] font-semibold tracking-tight">
              Name
            </h2>
            <p className="m-0 mt-2 max-w-[360px] text-muted text-[13px] leading-relaxed">
              {canManage
                ? "Shown across the product and in invite emails. The URL slug never changes."
                : "Only organization admins can rename the organization."}
            </p>
          </div>
          {canManage ? (
            <OrgNameForm initialName={org.name} orgId={org.id} />
          ) : (
            <p className="m-0 self-center text-[13px] text-ink">{org.name}</p>
          )}
        </div>
      </section>
      <section className="border border-line rounded-lg bg-surface p-[18px]">
        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.45fr)] gap-[18px]">
          <div>
            <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Slug
            </p>
            <p className="font-mono text-[13px]">{org.slug}</p>
          </div>
          <div>
            <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Organization ID
            </p>
            <p className="font-mono text-[13px]">{org.id}</p>
          </div>
          <div>
            <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Your role
            </p>
            <p className="text-[13px]">{org.role}</p>
          </div>
          <div>
            <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Credits
            </p>
            <p className="text-[13px]">
              {formatSignedCostUsd(org.credit_balance_usd)} remaining
              <span className="ml-1.5 text-muted-2 text-[12px]">
                of {formatCostUsd(org.credit_granted_usd)} granted
              </span>
            </p>
          </div>
        </div>
      </section>
      {canManage && <DeleteOrgDataCard orgId={org.id} orgSlug={org.slug} />}
    </div>
  );
}
