import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";
import { revalidateModelsCatalog } from "@/lib/models-catalog/server";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * Turn one Experiential Cloud lane ON (active) or OFF (disabled). Turning ON
 * routes real traffic once an origin resolves, so the UI confirms first.
 * Platform-admin surface; the backend re-validates and 404s an unknown id.
 */
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const status = body?.status;
    if (status !== "active" && status !== "disabled") {
      return NextResponse.json(
        { error: "status must be 'active' or 'disabled'." },
        { status: 400 }
      );
    }
    const deployment = await getDataSource().setAdminExperientialCloudStatus(id, status);
    // Lane ON/OFF renders on the shared cached public catalog; bust it.
    revalidateModelsCatalog();
    return NextResponse.json(deployment);
  } catch (error) {
    return jsonError(error);
  }
}
