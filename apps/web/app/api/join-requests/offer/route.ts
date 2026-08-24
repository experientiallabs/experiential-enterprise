import { type NextRequest } from "next/server";

import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

// The signed-in user's domain-match join offer (or { offer: null }). The
// backend resolves the acting user from the asserted session subject.
export async function GET(_request: NextRequest): Promise<Response> {
  try {
    return jsonOk(await getDataSource().getJoinOffer());
  } catch (error) {
    return jsonError(error);
  }
}
