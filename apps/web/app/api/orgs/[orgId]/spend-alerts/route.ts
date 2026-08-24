import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import type { CreateSpendAlertInput } from "@/lib/billing/spend-alerts";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string }> };

// List the org's spend-alert rules with their last-fired state (member-readable).
export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    return jsonOk(await getDataSource().listSpendAlerts(orgId));
  } catch (error) {
    return jsonError(error);
  }
}

// Create one spend-alert rule (org admins only; the backend enforces it and
// answers 409 for an identical rule, 404 for an unknown budget).
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    const body = (await request.json()) as CreateSpendAlertInput;
    return jsonOk(await getDataSource().createSpendAlert(orgId, body));
  } catch (error) {
    return jsonError(error);
  }
}
