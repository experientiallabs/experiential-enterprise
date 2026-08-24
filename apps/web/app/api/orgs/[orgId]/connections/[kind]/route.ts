import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { jsonError } from "@/lib/http";
import { TRACE_INGEST_PROVIDERS } from "@/lib/trace-ingest";

export const dynamic = "force-dynamic";

// The connection kinds Settings manages: the observability providers plus the
// database connection, exactly the trace_connections check constraint.
const CONNECTION_KINDS = [...TRACE_INGEST_PROVIDERS, "postgres"] as const;

type ConnectionKind = (typeof CONNECTION_KINDS)[number];

type Context = {
  params: Promise<{ orgId: string; kind: string }>;
};

/**
 * Connect or rotate one stored trace connection. Credentials go straight
 * into the Vault-backed upsert RPC (the same store the ingest flow writes
 * when a source carries credentials) and are never echoed back.
 */
export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireConnectionManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const body = (await request.json().catch(() => null)) as {
      secret?: unknown;
      config?: unknown;
    } | null;
    const secret = typeof body?.secret === "string" ? body.secret.trim() : "";
    if (secret.length === 0) {
      return NextResponse.json({ error: "A credential is required." }, { status: 400 });
    }
    const config =
      typeof body?.config === "object" && body.config !== null && !Array.isArray(body.config)
        ? (body.config as Record<string, unknown>)
        : {};
    const admin = createServiceRoleSupabaseClient();
    // The upsert replaces config wholesale, so a key rotation must carry the
    // stored broadcast settings forward or it would silently stop (or
    // un-privacy) an enabled broadcast. Server-side because the client's
    // view may lag and must never round-trip the capture token itself.
    if (!("broadcast" in config)) {
      const { data: existing } = await admin
        .from("trace_connections")
        .select("config")
        .eq("org_id", gate.orgId)
        .eq("kind", gate.kind)
        .maybeSingle();
      const stored = (existing?.config as Record<string, unknown> | null)?.broadcast;
      if (typeof stored === "object" && stored !== null) {
        config.broadcast = stored;
      }
    }
    const { data, error } = await admin.rpc("upsert_trace_connection", {
      in_org_id: gate.orgId,
      in_kind: gate.kind,
      in_config: config,
      in_secret: secret,
      in_actor: gate.userId
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({ connection: row });
  } catch (error) {
    return jsonError(error);
  }
}

// Destinations the broadcast tick can deliver to. Mastra has no public write
// contract for external events and postgres is a trace SOURCE, so both
// refuse the toggle explicitly instead of storing config nothing reads.
const BROADCAST_KINDS = new Set<ConnectionKind>([
  "braintrust",
  "langfuse",
  "langsmith",
  "phoenix",
  "posthog"
]);

/**
 * Update one connection's broadcast settings without touching the credential
 * (PUT is connect-or-rotate, so it requires a secret). Broadcast is an
 * explicit per-destination opt-in: `{ enabled, privacy_mode }` booleans plus
 * PostHog's public write-only capture token, stored under config.broadcast
 * through a config-merge RPC. Misconfigurations fail HERE, at the toggle,
 * not silently in the scheduled tick: PostHog needs the capture token and
 * Phoenix needs a connection host.
 */
export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireConnectionManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    if (!BROADCAST_KINDS.has(gate.kind)) {
      return NextResponse.json(
        { error: `Broadcast is not available for ${gate.kind}.` },
        { status: 400 }
      );
    }
    const body = (await request.json().catch(() => null)) as { broadcast?: unknown } | null;
    const broadcast =
      typeof body?.broadcast === "object" && body.broadcast !== null && !Array.isArray(body.broadcast)
        ? (body.broadcast as Record<string, unknown>)
        : null;
    const captureToken =
      typeof broadcast?.capture_token === "string" && broadcast.capture_token.trim().length > 0
        ? broadcast.capture_token.trim()
        : null;
    if (
      broadcast === null ||
      typeof broadcast.enabled !== "boolean" ||
      typeof broadcast.privacy_mode !== "boolean"
    ) {
      return NextResponse.json(
        { error: "broadcast must be { enabled: boolean, privacy_mode: boolean }." },
        { status: 400 }
      );
    }
    if (gate.kind === "posthog" && broadcast.enabled && captureToken === null) {
      return NextResponse.json(
        { error: "PostHog broadcast needs the project API key (phc_…)." },
        { status: 400 }
      );
    }
    const admin = createServiceRoleSupabaseClient();
    if (gate.kind === "phoenix" && broadcast.enabled) {
      const { data: existing } = await admin
        .from("trace_connections")
        .select("config")
        .eq("org_id", gate.orgId)
        .eq("kind", gate.kind)
        .maybeSingle();
      const host = (existing?.config as Record<string, unknown> | null)?.host;
      if (typeof host !== "string" || !host.startsWith("https://")) {
        return NextResponse.json(
          { error: "Phoenix broadcast needs the connection host (set it when connecting)." },
          { status: 400 }
        );
      }
    }
    const patch: Record<string, unknown> = {
      enabled: broadcast.enabled,
      privacy_mode: broadcast.privacy_mode
    };
    if (captureToken !== null) {
      patch.capture_token = captureToken;
    }
    const { data, error } = await admin.rpc("update_trace_connection_config", {
      in_org_id: gate.orgId,
      in_kind: gate.kind,
      in_patch: { broadcast: patch }
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    return NextResponse.json({ connection: row });
  } catch (error) {
    return jsonError(error);
  }
}

/** Disconnect: the definer RPC removes the row and its Vault secret. */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const gate = await requireConnectionManager(context);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin.rpc("delete_trace_connection", {
      in_org_id: gate.orgId,
      in_kind: gate.kind
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (data !== true) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}

/** Resolve org + kind and require org-admin (or experiential-admin) rights. */
async function requireConnectionManager(
  context: Context
): Promise<NextResponse | { orgId: string; kind: ConnectionKind; userId: string }> {
  const { orgId: orgIdentifier, kind } = await context.params;
  if (!CONNECTION_KINDS.includes(kind as ConnectionKind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${CONNECTION_KINDS.join(", ")}.` },
      { status: 400 }
    );
  }
  const user = await requireAuthenticatedUser();
  const orgId = await requireOrgId(orgIdentifier);
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, orgId));
  if (!canManage) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return { orgId, kind: kind as ConnectionKind, userId: user.id };
}
