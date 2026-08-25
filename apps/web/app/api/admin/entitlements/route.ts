import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Every entitlement grant on the deployment (the Enterprise tab's read). */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(await getDataSource().listAllOrgEntitlements());
  } catch (error) {
    return jsonError(error);
  }
}
