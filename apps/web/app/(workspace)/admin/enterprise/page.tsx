import { EnterpriseBrowse } from "@/components/admin/EnterpriseBrowse";
import { getDataSource } from "@/lib/data-source";
import { createServerSupabaseClient } from "@/lib/auth/server";

export const metadata = { title: "Admin — Enterprise" };

export const dynamic = "force-dynamic";

// PostgREST truncates unwindowed selects at 1000 rows; page the org roster so
// every organization stays searchable (and every grant row can mount its
// editor) on deployments past that count. Keyset on the unique immutable id —
// absolute offsets would skip or duplicate orgs when a concurrent signup or
// deletion shifts the table between windows.
const ORG_PAGE_SIZE = 1000;

type OrgRow = { id: string; slug: string; name: string };

async function listAllOrganizations(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>
): Promise<OrgRow[]> {
  const orgs: OrgRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from("organizations")
      .select("id, slug, name")
      .order("id")
      .limit(ORG_PAGE_SIZE);
    if (cursor !== null) {
      query = query.gt("id", cursor);
    }
    const result = await query;
    if (result.error) {
      throw new Error(`Unable to list organizations: ${result.error.message}`);
    }
    const page = result.data ?? [];
    orgs.push(
      ...page.map((org) => ({ id: String(org.id), slug: String(org.slug), name: String(org.name) }))
    );
    if (page.length < ORG_PAGE_SIZE) {
      return orgs.sort((a, b) => a.name.localeCompare(b.name));
    }
    cursor = String(page[page.length - 1].id);
  }
}

/**
 * The Enterprise section: the deployment's entitlement switchboard. A grant
 * licenses ONE organization for one enterprise feature (the hosted tier of
 * the capability registry); without one the feature is absent from that
 * org's product entirely — no locked pages, no upsell. The eyebrow and
 * section tabs come from the admin layout above (which already gates on
 * platform-admin); the backend re-gates every read and write, and each
 * grant/revoke is an audit event. Self-hosted licensed installs use the
 * EXPLABS_EE_CAPABILITIES instance license instead of rows here.
 */
export default async function AdminEnterprisePage() {
  const supabase = await createServerSupabaseClient();
  const [{ entitlements }, orgs] = await Promise.all([
    getDataSource().listAllOrgEntitlements(),
    listAllOrganizations(supabase)
  ]);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ink">Enterprise entitlements</h1>
        <p className="mt-1 max-w-[780px] text-sm leading-relaxed text-muted">
          Grant enterprise features to specific organizations. An ungranted org has no trace of
          a feature — the pages 404 and the settings entries do not render. Every grant and
          revoke is recorded in that org&apos;s audit log.
        </p>
      </div>
      <EnterpriseBrowse grants={entitlements} orgs={orgs} />
    </div>
  );
}
