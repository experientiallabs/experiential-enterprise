import { NextResponse } from "next/server";

import { resolveActiveOrg } from "@/lib/active-org";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthorizedOrgIds } from "@/lib/auth/orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { readLaunchGrantUsd } from "@/lib/billing/launch-grant";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

// The login modal's success-step read (components/auth/welcome-data.ts, its
// only consumer): the active org, whether it already holds an active API key
// (recognition prefix only — plaintext is hash-stored and unrecoverable),
// whether the caller may mint one, and the credit grant the ledger shows.
export async function GET(): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    // Guard before resolveActiveOrg(): a memberless session must get JSON the
    // modal can degrade on, not that helper's redirect to the /orgs page.
    const authorizedOrgIds = await requireAuthorizedOrgIds();
    if (authorizedOrgIds.size === 0) {
      return NextResponse.json(
        { code: "no_org", error: "No organization membership yet." },
        { status: 404 }
      );
    }
    const org = await resolveActiveOrg();

    // Same access model as the API-keys settings page: platform admins read
    // through the service role (api_keys rows are only RLS-visible via
    // membership); members read RLS-scoped, org-admins may mint.
    const platformAdmin = await isPlatformAdmin();
    const canManageKeys = platformAdmin || (await isOrgAdmin(user.id, org.id));
    const supabase = platformAdmin
      ? createServiceRoleSupabaseClient()
      : await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("api_keys")
      .select("key_prefix, key_suffix")
      .eq("org_id", org.id)
      .is("revoked_at", null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // The ANNOUNCED credit figure is the launch-grant EVENT amount from the
    // ledger ($20 standard signup, the YC amount on a claim) — never the
    // cumulative granted counter, which also counts Stripe top-ups (the same
    // rule as the sidebar greeting, PR #685). billableUsd still gates the
    // celebration: an org that has already spent is not a fresh welcome.
    const [budget, launchGrantUsd] = await Promise.all([
      getDataSource().getOrgBudget(org.id),
      readLaunchGrantUsd(supabase, org.id)
    ]);
    return jsonOk(
      {
        org: { id: org.id, slug: org.slug },
        apiKey: data?.[0]
          ? { keyPrefix: data[0].key_prefix, keySuffix: data[0].key_suffix }
          : null,
        canManageKeys,
        credit: {
          grantedUsd: launchGrantUsd ?? 0,
          billableUsd: budget.billable_spend_usd
        }
      },
      { "cache-control": "no-store" }
    );
  } catch (error) {
    return jsonError(error);
  }
}
