import { NextResponse } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

// A question longer than this is not a usage question; the backend classifier
// only reads keywords, so a bounded length keeps the proxy honest and cheap.
const MAX_QUESTION_LENGTH = 300;

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Answer a plain-language question over the org's own usage. Read-only and
 * org-scoped: the body carries only the question, the window is parsed from it
 * server-side, and the backend never runs free-form SQL.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const body = (await request.json().catch(() => null)) as { question?: unknown } | null;
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
      return NextResponse.json(
        { error: `question must be 1-${MAX_QUESTION_LENGTH} characters.` },
        { status: 400 }
      );
    }
    const answer = await getDataSource().queryInsights(orgId, question);
    return jsonOk(answer, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
