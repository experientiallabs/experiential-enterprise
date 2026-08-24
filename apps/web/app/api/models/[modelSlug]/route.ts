import { NextResponse, type NextRequest } from "next/server";

import { getCatalogDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ modelSlug: string }>;
};

/**
 * One model's catalog detail (row, deployments, default waterfall chain),
 * proxied from the backend's public catalog read. Signed-out visitors get the
 * public catalog; a signed-in visitor's actor is asserted so their org's own
 * rows appear, and an explicit orgId query pins that org's slug namespace
 * (the backend 404s an org the actor cannot see).
 */
export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { modelSlug } = await context.params;
    const orgId = request.nextUrl.searchParams.get("orgId");
    const detail = await getCatalogDataSource().getModelDetail(modelSlug, orgId ?? undefined);
    return NextResponse.json(detail);
  } catch (error) {
    return jsonError(error);
  }
}
