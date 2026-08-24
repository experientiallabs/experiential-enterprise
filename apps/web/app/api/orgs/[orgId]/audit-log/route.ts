import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * The org audit trail, proxied from the backend like the other org-scoped
 * panels. The backend admin-gates the read per the acting user; this route
 * only canonicalizes the org identifier. `?format=csv` streams the backend's
 * CSV export through as a download for the panel's "Download CSV" link.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const { searchParams } = new URL(request.url);
    const limitParam = Number.parseInt(searchParams.get("limit") ?? "", 10);
    const query = {
      action: searchParams.get("action"),
      objectType: searchParams.get("object_type"),
      // Newest-first cursor paging: `before` is the exclusive upper bound.
      before: searchParams.get("before"),
      ...(Number.isFinite(limitParam) && limitParam > 0 ? { limit: limitParam } : {})
    };
    if (searchParams.get("format") === "csv") {
      const csv = await getDataSource().getOrgAuditLogCsv(orgId, query);
      return new Response(csv, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="audit-log.csv"'
        }
      });
    }
    const events = await getDataSource().getOrgAuditLog(orgId, query);
    return jsonOk(events, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
