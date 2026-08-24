import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";
import type { SetBudgetInput } from "@/lib/identities/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string }> };

// List the org's budgets for a month with balances (member-readable).
export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    const period = new URL(request.url).searchParams.get("period") ?? "";
    return jsonOk(await getDataSource().listBudgets(orgId, period));
  } catch (error) {
    return jsonError(error);
  }
}

// Set (create or replace) the monthly limit for one scope (org admins only).
export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    const body = (await request.json()) as SetBudgetInput;
    return jsonOk(await getDataSource().setBudget(orgId, body));
  } catch (error) {
    return jsonError(error);
  }
}
