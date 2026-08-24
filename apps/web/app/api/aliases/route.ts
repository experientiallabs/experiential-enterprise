import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, requireField } from "@/lib/http";

export const dynamic = "force-dynamic";

// List an organization's named aliases. The backend admin-gates the read per
// the acting user; the org is named on the query string.
export async function GET(request: Request): Promise<Response> {
  try {
    const orgId = requireField(new URL(request.url).searchParams.get("org_id"), "org_id");
    return jsonOk(await getDataSource().listNamedAliases(orgId));
  } catch (error) {
    return jsonError(error);
  }
}

// Create a named alias pointing at a model's current catalog revision.
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { org_id?: string; name?: string; model?: string };
    const orgId = requireField(body.org_id, "org_id");
    const name = requireField(body.name, "name");
    const model = requireField(body.model, "model");
    return jsonOk(await getDataSource().createNamedAlias(orgId, name, model));
  } catch (error) {
    return jsonError(error);
  }
}
