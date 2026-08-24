import { IdentitiesAccessPanel } from "@/components/identities/identities-access-panel";
import { AliasesPanel } from "@/components/settings/AliasesPanel";
import { resolveActiveOrg } from "@/lib/active-org";
import { listOrgApiKeySummaries } from "@/lib/api-keys/queries";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import type { AliasModelOption, NamedAliasList } from "@/lib/aliases/types";
import { currentBudgetPeriod } from "@/lib/identities/types";

export const metadata = { title: "Access control" };

export const dynamic = "force-dynamic";

/**
 * Access control, one first-class page (renamed from "Aliases & access",
 * aliases-page redesign 2026-08-23: the label now names the whole surface, not
 * just its first section). Two tiers on one viewport-filling page: the org's
 * named model aliases (admin-managed end to end), then the identity tier:
 * principals, their keys, the models each may call, and their budgets. Every
 * member reads the identity tier; org admins manage everything. Desktop locks
 * to the viewport (telemetry-view pattern) with each region scrolling
 * internally; below lg the page flows and scrolls naturally. On short desktop
 * viewports the identity tier's min-height floor wins over the viewport lock
 * and the page overflows into the app shell's main scroll instead of
 * collapsing the tier to zero.
 */
export default async function AliasesPage() {
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();
  const platformAdmin = await isPlatformAdmin();
  const canManage = platformAdmin || (await isOrgAdmin(user.id, org.id));
  const period = currentBudgetPeriod();

  // Same client split as the API-keys page: api_keys rows are only
  // RLS-visible via membership, so a memberless platform admin reads through
  // the service role.
  const keyReader = platformAdmin
    ? createServiceRoleSupabaseClient()
    : await createServerSupabaseClient();

  const source = getDataSource();

  async function loadAliases(): Promise<{
    aliasList: NamedAliasList;
    modelOptions: AliasModelOption[];
  }> {
    const [aliasList, modelOptions] = await Promise.all([
      source.listNamedAliases(org.id),
      source.listAliasModelOptions()
    ]);
    return { aliasList, modelOptions };
  }

  // The alias list is an admin read end to end (the backend refuses a
  // non-admin list call), so a member's page skips it and explains instead.
  const [aliasData, identities, matrix, budgets, keys] = await Promise.all([
    canManage ? loadAliases() : Promise.resolve(null),
    source.listIdentities(org.id),
    source.getGrantMatrix(org.id),
    source.listBudgets(org.id, period),
    listOrgApiKeySummaries(keyReader, org.id)
  ]);

  return (
    <div className="flex min-h-full flex-col gap-5 lg:h-full lg:min-h-0">
      <div className="shrink-0">
        <h1 className="m-0 text-ink text-xl font-semibold">Access control</h1>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Who and what may call your models: the named aliases your code targets, the identities
          behind your API keys, and the budgets that cap their spend.
        </p>
      </div>
      {aliasData !== null ? (
        <AliasesPanel
          aliases={aliasData.aliasList.aliases}
          models={aliasData.modelOptions}
          orgId={org.id}
        />
      ) : (
        <p className="m-0 shrink-0 rounded-lg border border-line bg-surface p-[18px] text-muted text-[13px] leading-relaxed">
          Named aliases are stable model names your code can call, repointed by organization
          admins over time. Ask an admin to create or repoint an alias for this organization.
        </p>
      )}
      <IdentitiesAccessPanel
        budgets={budgets.budgets}
        canManage={canManage}
        identities={identities.identities}
        keys={keys}
        matrix={matrix}
        orgId={org.id}
        period={period}
      />
    </div>
  );
}
