import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/** List one org's labels. Platform-admin surface. */
export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const labels = await getDataSource().listAdminOrgLabels(orgId);
    return NextResponse.json({ labels });
  } catch (error) {
    return jsonError(error);
  }
}

/** Apply a label to an org (idempotent). Platform-admin surface. */
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const key = body?.key;
    if (typeof key !== "string" || key.trim() === "") {
      return NextResponse.json({ error: "A label key is required." }, { status: 400 });
    }
    const label = await getDataSource().addAdminOrgLabel(orgId, key.trim());
    return NextResponse.json(label, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
