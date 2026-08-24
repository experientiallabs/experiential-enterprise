import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, requireField, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ name: string }> };

// Repoint a named alias at a different model (a new revision).
export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const { name } = await routeParams(context.params);
    const body = (await request.json()) as { org_id?: string; model?: string };
    const orgId = requireField(body.org_id, "org_id");
    const model = requireField(body.model, "model");
    return jsonOk(await getDataSource().repointNamedAlias(orgId, name, model));
  } catch (error) {
    return jsonError(error);
  }
}

// Retire a named alias (reversible via rollback).
export async function DELETE(request: Request, context: Context): Promise<Response> {
  try {
    const { name } = await routeParams(context.params);
    const orgId = requireField(new URL(request.url).searchParams.get("org_id"), "org_id");
    await getDataSource().deactivateNamedAlias(orgId, name);
    return jsonOk({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
