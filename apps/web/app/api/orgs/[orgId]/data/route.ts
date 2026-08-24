import { NextResponse, type NextRequest } from "next/server";

import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Delete all of this organization's product data: every retained world model
 * (which cascades its traces, builds, sessions, rollouts, and artifacts
 * through the backend's retained wipe, so storage objects and sandbox ids
 * drain durably too) plus the telemetry span store. The organization itself survives with its
 * members, API keys, credits, and spend history: this is the privacy wipe,
 * not tenant deletion (that stays with the experiential admin).
 *
 * No spend bookkeeping happens here on purpose. The spend triggers' DELETE
 * legs move only the display meter, never `billable_spend_usd` (money stays
 * spent when its rows are wiped — enforced in the database, so no delete
 * path, concurrent or partial, can refund credits).
 */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await context.params;
    const user = await requireAuthenticatedUser();
    const orgId = await requireOrgId(orgIdentifier);
    const platformAdmin = await isPlatformAdmin();
    const canManage = platformAdmin || (await isOrgAdmin(user.id, orgId));
    if (!canManage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Through the backend's wipe, never a raw table sweep: it stages each
    // model's storage objects and sandbox ids in the durable cleanup outbox
    // before the relational cascade commits.
    const wiped = await getDataSource().deleteOrgData(orgId);

    // Telemetry spans are platform-side rows with no engine state; the
    // service role clears them directly (sets cascade their spans).
    const admin = createServiceRoleSupabaseClient();
    const spanSets = await admin.from("telemetry_span_sets").delete().eq("org_id", orgId);
    if (spanSets.error) {
      return NextResponse.json({ error: spanSets.error.message }, { status: 500 });
    }
    const spans = await admin.from("telemetry_spans").delete().eq("org_id", orgId);
    if (spans.error) {
      return NextResponse.json({ error: spans.error.message }, { status: 500 });
    }

    // Opt-in captured prompts are customer content; the privacy wipe removes
    // them regardless of the capture toggle's current state.
    const capturedPrompts = await admin
      .from("gateway_captured_prompts")
      .delete()
      .eq("org_id", orgId);
    if (capturedPrompts.error) {
      return NextResponse.json({ error: capturedPrompts.error.message }, { status: 500 });
    }

    // Ingest history holds the customer's raw and normalized trace objects
    // (upload_path/result_path); remove the bytes first, loudly, then the
    // rows. Stored connections survive: they are credentials, managed in
    // Settings > Integrations, not data.
    const ingests = await admin
      .from("trace_ingests")
      .select("upload_path, result_path")
      .eq("org_id", orgId);
    if (ingests.error) {
      return NextResponse.json({ error: ingests.error.message }, { status: 500 });
    }
    type IngestRow = { upload_path: string | null; result_path: string | null };
    const objectPaths = ((ingests.data ?? []) as IngestRow[])
      .flatMap((row) => [row.upload_path, row.result_path])
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    if (objectPaths.length > 0) {
      const removal = await admin.storage.from("explabs-artifacts").remove(objectPaths);
      if (removal.error) {
        return NextResponse.json({ error: removal.error.message }, { status: 500 });
      }
    }
    const ingestRows = await admin.from("trace_ingests").delete().eq("org_id", orgId);
    if (ingestRows.error) {
      return NextResponse.json({ error: ingestRows.error.message }, { status: 500 });
    }

    // Deliberately NOT audited here: the backend's DELETE /api/orgs/{id}/data
    // handler (which deleteOrgData above proxies to) already emits
    // org.data_delete — the mutation is audited at exactly the layer that
    // owns it, and a second web-side emit would double-count every wipe.
    return NextResponse.json({ deleted_world_models: wiped.deleted_world_models });
  } catch (error) {
    return jsonError(error);
  }
}
