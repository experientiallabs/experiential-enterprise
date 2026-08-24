import { NextResponse } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Batch map of org_id -> label keys, for the admin org-list badges (one read,
 * no N+1 per row). Platform-admin surface; anyone else gets the not-found.
 */
export async function GET(): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const labels = await getDataSource().getAdminOrgLabels();
    return NextResponse.json({ labels });
  } catch (error) {
    return jsonError(error);
  }
}
