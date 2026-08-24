import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";
import { MODEL_PROVIDERS, isModelProvider } from "@/lib/model-providers";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; provider: string }>;
};

/**
 * Thin proxy to the backend's spend refresh: read what this provider account
 * reports (spend, credits, limits), store it as a provider_account_snapshots
 * row, and return the reading. Refreshing "quite often" is fine — the backend
 * enforces per-provider staleness floors and answers from the stored snapshot
 * inside them, so this route is safe to wire to a per-row refresh affordance.
 * These reads never route through the gateway/serving path.
 */
export async function POST(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, provider } = await context.params;
    if (!isModelProvider(provider)) {
      return NextResponse.json(
        { error: `provider must be one of: ${MODEL_PROVIDERS.join(", ")}.` },
        { status: 400 }
      );
    }
    const user = await requireAuthenticatedUser();
    const orgId = await requireOrgId(orgIdentifier);
    const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, orgId));
    if (!canManage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const refresh = await getDataSource().refreshProviderSpend(orgId, provider);
    return NextResponse.json(refresh);
  } catch (error) {
    return jsonError(error);
  }
}
