import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";
import { MODEL_PROVIDERS, isModelProvider } from "@/lib/model-providers";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; provider: string }>;
};

/**
 * Thin proxy to the backend's per-model deployment check — the model page's
 * Azure question: "you have a key, but is THIS model deployed?". The body
 * carries the model slug and, for the least-clicks inline add, optionally the
 * deployment name to map first. The backend persists the model-scoped fact
 * under status_detail.models without touching the key-level status, so this
 * is not a manual recheck surface either.
 */
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, provider } = await context.params;
    if (!isModelProvider(provider)) {
      return NextResponse.json(
        { error: `provider must be one of: ${MODEL_PROVIDERS.join(", ")}.` },
        { status: 400 }
      );
    }
    const user = await requireAuthenticatedUser();
    const orgId = await requireOrgId(orgIdentifier);
    const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, orgId));
    if (!canManage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as {
      model?: unknown;
      deployment?: unknown;
    } | null;
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    if (model.length === 0) {
      return NextResponse.json(
        { error: "model must name the catalog model slug the deployment serves." },
        { status: 400 }
      );
    }
    if (body?.deployment !== undefined && typeof body.deployment !== "string") {
      return NextResponse.json(
        { error: "deployment must be the Azure deployment name as text." },
        { status: 400 }
      );
    }
    const deployment = typeof body?.deployment === "string" ? body.deployment.trim() : "";
    const check = await getDataSource().checkModelDeployment(orgId, provider, {
      model,
      ...(deployment.length > 0 ? { deployment } : {})
    });
    return NextResponse.json(check);
  } catch (error) {
    return jsonError(error);
  }
}
