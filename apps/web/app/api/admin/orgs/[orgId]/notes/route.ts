import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/** List one org's internal admin notes, newest first. Platform-admin surface. */
export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const notes = await getDataSource().listAdminOrgNotes(orgId);
    return NextResponse.json({ notes });
  } catch (error) {
    return jsonError(error);
  }
}

/** Post an author-attributed internal note on an org. Platform-admin surface. */
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const text = body?.body;
    if (typeof text !== "string" || text.trim() === "") {
      return NextResponse.json({ error: "A note body is required." }, { status: 400 });
    }
    const note = await getDataSource().addAdminOrgNote(orgId, text.trim());
    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
