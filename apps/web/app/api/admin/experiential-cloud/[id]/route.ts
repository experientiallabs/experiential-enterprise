import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";
import { revalidateModelsCatalog } from "@/lib/models-catalog/server";

import { parseUpdateInput } from "../route";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * Edit one Experiential Cloud lane's hookup info: endpoint, provider_model_id,
 * and prices (the id rides the path). Turning it ON/OFF is a separate action
 * (POST .../status). Platform-admin surface; the backend re-validates and 404s
 * an unknown id. The upstream bearer stays a worker secret and is never sent.
 */
export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parseUpdateInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const deployment = await getDataSource().updateAdminExperientialCloud(id, parsed.value);
    // Price/state edits render on the shared cached public catalog; bust it.
    revalidateModelsCatalog();
    return NextResponse.json(deployment);
  } catch (error) {
    return jsonError(error);
  }
}
