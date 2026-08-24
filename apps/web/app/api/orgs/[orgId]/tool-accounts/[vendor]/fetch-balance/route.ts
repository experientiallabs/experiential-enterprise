import { NextResponse, type NextRequest } from "next/server";

import { requireToolAccountManager } from "@/app/api/orgs/[orgId]/tool-accounts/[vendor]/route";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; vendor: string }>;
};

/**
 * Ask the vendor for this account's real balance and store the verdict. Same
 * manager + vendor-validation + YC gate as the upsert route. The backend picks
 * the strategy (a deterministic vendor API where one exists, computer-use
 * otherwise) and may answer "pending" for an async computer-use fetch.
 */
export async function POST(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireToolAccountManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const result = await getDataSource().fetchToolAccountBalance(gate.orgId, gate.vendor);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
