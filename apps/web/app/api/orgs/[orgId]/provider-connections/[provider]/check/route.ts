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
 * Thin proxy to the backend's hookup check so the browser-side key flows
 * (the model page's inline add, KeyHub) can render a fresh verdict after a
 * mutation. This is NOT a manual recheck surface — the check runs inside
 * connect/rotate and afterwards only traffic updates the status; no UI may
 * mount a recheck button or poll this route.
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
    const check = await getDataSource().checkProviderConnection(orgId, provider);
    return NextResponse.json(check);
  } catch (error) {
    return jsonError(error);
  }
}
