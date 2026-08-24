import { resolveActiveOrg } from "@/lib/active-org";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";
import { fetchOrgOwnedModels, revalidateModelsCatalog } from "@/lib/models-catalog/server";
import type { ModelCreateInput } from "@/lib/models-catalog/types";

export const dynamic = "force-dynamic";

// The signed-in viewer's ACTIVE organization's own custom models — the thin
// per-user overlay the /models storefront hydrates client-side over the shared
// cached public base (see lib/models-catalog/server.ts). Public catalog reads
// still come from the page's server-side cached base, never here; this endpoint
// only ever returns org-scoped rows, so a signed-out caller gets an empty list
// rather than the public catalog again.
//
// The backend's owner=org list spans EVERY organization the actor belongs to,
// so we filter it to the active org by owning_org_id: a member of several orgs
// sees only the org they are currently acting in, matching the rest of the
// workspace's active-org scoping instead of pooling all their orgs' private
// models into one catalog.
export async function GET(): Promise<Response> {
  try {
    const user = await getAuthenticatedUser();
    if (user === null) {
      return jsonOk({ models: [], total: 0, limit: 0, offset: 0 }, { "cache-control": "no-store" });
    }
    const [activeOrg, overlay] = await Promise.all([resolveActiveOrg(), fetchOrgOwnedModels(user.id)]);
    const models = overlay.models.filter((entry) => entry.model.owning_org_id === activeOrg.id);
    return jsonOk(
      { models, total: models.length, limit: overlay.limit, offset: 0 },
      { "cache-control": "no-store" }
    );
  } catch (error) {
    return jsonError(error);
  }
}

// Create a custom model (the /models/new form). Auth and org membership are
// enforced end to end: getDataSource() requires a session for the actor
// header, and the backend validates the actor's role in body.org_id before
// writing (explabs/api/routes/models_catalog.py). Public catalog READS never
// come through here — pages fetch them server-side.
export async function POST(request: Request): Promise<Response> {
  try {
    const input = (await request.json()) as ModelCreateInput;
    const created = await getDataSource().createCatalogModel(input);
    // Bust the shared catalog cache so the new model appears for every viewer
    // on their next read instead of waiting out the revalidate window.
    revalidateModelsCatalog();
    return jsonOk(created);
  } catch (error) {
    return jsonError(error);
  }
}
