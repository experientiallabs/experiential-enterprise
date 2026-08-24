import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";
import type { DeploymentCreateInput } from "@/lib/models-catalog/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ modelSlug: string }> };

// Add a deployment — the model detail page's "add a local variant" form. The
// backend enforces the actor's role in body.org_id and the provider's
// base_url rules; its 4xx messages are written to be shown verbatim.
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { modelSlug } = await routeParams(context.params);
    const input = (await request.json()) as DeploymentCreateInput;
    return jsonOk(await getDataSource().addCatalogDeployment(modelSlug, input));
  } catch (error) {
    return jsonError(error);
  }
}
