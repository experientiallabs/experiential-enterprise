import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";
import type { CreateIdentityInput } from "@/lib/identities/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string }> };

// List the org's identities (member-readable). The backend enforces the role;
// requireOrgId gives a non-member the same 404 an absent org gets.
export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    return jsonOk(await getDataSource().listIdentities(orgId));
  } catch (error) {
    return jsonError(error);
  }
}

// Create one named identity (org admins only; the backend enforces it).
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    const body = (await request.json()) as CreateIdentityInput;
    return jsonOk(await getDataSource().createIdentity(orgId, body));
  } catch (error) {
    return jsonError(error);
  }
}
