import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ modelSlug: string }> };

// The org waterfall override (model detail page editor). Reads and writes
// both act for one org; the backend enforces the actor's membership and that
// every rung is a deployment of this model visible to that org.
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { modelSlug } = await routeParams(context.params);
    const orgId = new URL(request.url).searchParams.get("orgId");
    if (orgId === null || orgId.length === 0) {
      return Response.json({ error: "orgId is required." }, { status: 400 });
    }
    return jsonOk(await getDataSource().getCatalogWaterfall(modelSlug, orgId));
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const { modelSlug } = await routeParams(context.params);
    const input = (await request.json()) as { org_id?: string; model_provider_ids?: string[] };
    if (typeof input.org_id !== "string" || input.org_id.length === 0) {
      return Response.json({ error: "org_id is required." }, { status: 400 });
    }
    if (!Array.isArray(input.model_provider_ids)) {
      return Response.json({ error: "model_provider_ids must be a list." }, { status: 400 });
    }
    return jsonOk(
      await getDataSource().putCatalogWaterfall(modelSlug, input.org_id, input.model_provider_ids)
    );
  } catch (error) {
    return jsonError(error);
  }
}
