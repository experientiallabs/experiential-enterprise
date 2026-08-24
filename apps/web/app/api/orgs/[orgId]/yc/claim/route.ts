import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * One-click /yc launch grant: $526 of credits for the signed-in member's
 * org — replacing the $20 welcome promo, so the total launch credit is
 * exactly $526 — expiring after three months.
 * Deliberately open to every org member (not admin-gated) — the /yc page
 * calls this right after signup. A repeat claim by the same account or org
 * forwards the backend's 409 with its message verbatim, which is the copy
 * the /yc page shows next to the "DM me" recovery path.
 */
export async function POST(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    // Resolve id-or-slug and gate on membership; the backend keys on the UUID
    // and re-checks the member role for the acting user.
    const orgId = await requireOrgId(orgIdentifier);
    const claim = await getDataSource().postYcClaim(orgId);
    return jsonOk(claim, { "cache-control": "no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
