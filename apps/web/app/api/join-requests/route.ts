import { type NextRequest } from "next/server";

import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

// Open a pending request to join the acting user's domain-matched org. The
// backend enforces the domain match, email verification, and non-membership
// (403/404/409 respectively).
export async function POST(_request: NextRequest): Promise<Response> {
  try {
    return jsonOk(await getDataSource().requestOrgAccess());
  } catch (error) {
    return jsonError(error);
  }
}
