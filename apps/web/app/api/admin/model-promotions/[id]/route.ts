import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";
import { revalidateModelsCatalog } from "@/lib/models-catalog/server";

import { parsePromotionInput } from "../route";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * Edit a promotion (full-resource body; the id rides the path). Platform-admin
 * surface; the backend re-validates and 404s an unknown id.
 */
export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parsePromotionInput(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const promotion = await getDataSource().updateAdminModelPromotion(id, parsed.value);
    // Promotions render on the shared cached public catalog; bust it so the
    // change shows on the next read instead of waiting out the window.
    revalidateModelsCatalog();
    return NextResponse.json(promotion);
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Remove a promotion. Platform-admin surface.
 */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { id } = await context.params;
    await getDataSource().deleteAdminModelPromotion(id);
    revalidateModelsCatalog();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
