import { OrgsBrowse } from "@/components/admin/OrgsBrowse";
import { listAdministeredOrgs } from "@/lib/admin/orgs-server";

export const metadata = { title: "Admin" };

export const dynamic = "force-dynamic";

/**
 * The Organizations section: every tenant as a card that clicks through to its
 * admin detail page. The eyebrow and section tabs (this / Insights) come from
 * the admin layout above; creation, search, sort, and filter live in the browse
 * component, per-org management on the detail page it links to.
 */
export default async function AdminIndexPage() {
  const orgs = await listAdministeredOrgs();
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ink">Organizations and members</h1>
        <p className="mt-2 max-w-[780px] text-sm leading-relaxed text-muted">
          Create tenants and browse every organization. Open a card to add or invite members, set
          usage limits, grant credit, or delete the account. This panel spans every organization;
          customers never see it.
        </p>
      </div>
      <OrgsBrowse orgs={orgs} />
    </div>
  );
}
