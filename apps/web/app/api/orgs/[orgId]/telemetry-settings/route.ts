import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";
import type { TelemetrySettings } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string }> };

// The org's telemetry privacy settings (member-readable).
export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    return jsonOk(await getDataSource().getTelemetrySettings(orgId), {
      "cache-control": "private, no-store"
    });
  } catch (error) {
    return jsonError(error);
  }
}

// Opt in or out of capturing request/response content (org admins only).
export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    const body = (await request.json()) as TelemetrySettings;
    return jsonOk(
      await getDataSource().setTelemetrySettings(orgId, {
        capture_prompt_content: Boolean(body?.capture_prompt_content)
      })
    );
  } catch (error) {
    return jsonError(error);
  }
}
