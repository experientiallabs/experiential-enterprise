import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { ConnectionState, IntegrationsPanel } from "@/components/settings/IntegrationsPanel";
import { ModelProvidersPanel } from "@/components/settings/ModelProvidersPanel";
import { PromptCaptureCard } from "@/components/settings/PromptCaptureCard";
import { publicServingBaseUrl } from "@/components/world-models/endpoint-snippets";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { loadProviderConnections } from "@/lib/billing/provider-balances-server";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";
import { TRACE_INGEST_PROVIDERS } from "@/lib/trace-ingest";

export const metadata = { title: "Connections" };

export const dynamic = "force-dynamic";

// Every managed trace-connection kind: the D-INGEST providers plus the database
// connection, matching the trace_connections check constraint.
const CONNECTION_KINDS = [...TRACE_INGEST_PROVIDERS, "postgres"] as const;

/**
 * Connections: everything the org hooks up, on one page (the product owner,
 * credits/settings redesign 2026-08-22 — the Providers and Observability
 * sections collapsed into one). Model providers (BYOK keys) first, then the
 * observability trace sources with the prompt-content-capture switch under
 * them. Both sections read the same stores their previous dedicated pages did,
 * so nothing about the data model moved — only the IA.
 */
export default async function ConnectionsSettingsPage({
  searchParams
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  // Settings is workspace-private (main's proxy bounces signed-out to /signin).
  const user = await requireAuthenticatedUser();
  const requestedReturn = (await searchParams).returnTo;
  const returnTo =
    requestedReturn?.startsWith("/projects/") === true ? requestedReturn : null;
  const org = await resolveActiveOrg();
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));
  const webBaseUrl = process.env.EXPLABS_WEBAPP_URL ?? PLATFORM_WEB_URL;

  const providerConnections = await loadProviderConnections(org.id);

  // Member-readable under RLS: the row carries only non-secret state (the
  // credential lives in Vault behind service-role RPCs). The explicit org
  // filter keeps a multi-org member's other connections off this page.
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("trace_connections")
    .select("kind, config, credential_last4, updated_at")
    .eq("org_id", org.id);
  if (error) {
    throw new Error(`Unable to load connections: ${error.message}`);
  }
  type Row = {
    kind: string;
    config: Record<string, unknown> | null;
    credential_last4: string | null;
    updated_at: string;
  };
  const byKind = new Map(((data ?? []) as Row[]).map((row) => [row.kind, row]));
  const traceConnections: ConnectionState[] = CONNECTION_KINDS.map((kind) => {
    const row = byKind.get(kind);
    // Broadcast settings ride the connection config; absent means disabled
    // (broadcast is an explicit opt-in, never implied by connecting).
    const broadcast =
      typeof row?.config?.broadcast === "object" && row.config.broadcast !== null
        ? (row.config.broadcast as Record<string, unknown>)
        : null;
    return {
      kind,
      connected: row !== undefined,
      credentialLast4: row?.credential_last4 ?? null,
      host: typeof row?.config?.host === "string" ? (row.config.host as string) : null,
      updatedAt: row?.updated_at ?? null,
      broadcastEnabled: broadcast?.enabled === true,
      broadcastPrivacyMode: broadcast?.privacy_mode === true,
      // PostHog's capture token is public write-only by PostHog's own
      // definition (it ships to browsers), so it lives in member-readable
      // config rather than Vault and can round-trip through the UI.
      broadcastCaptureToken:
        typeof broadcast?.capture_token === "string" ? broadcast.capture_token : null
    };
  });

  return (
    <div className="flex flex-col gap-8">
      {returnTo === null ? null : (
        <Link className="inline-flex w-fit items-center gap-1.5 text-[12px] font-medium text-muted hover:text-ink" href={returnTo}>
          <ArrowLeft aria-hidden size={13} /> Return to Project
        </Link>
      )}
      <ModelProvidersPanel
        apiBaseUrl={publicServingBaseUrl()}
        canManage={canManage}
        connections={providerConnections}
        orgId={org.id}
        webBaseUrl={webBaseUrl}
      />
      <div className="flex flex-col gap-5">
        <IntegrationsPanel
          canManage={canManage}
          connections={traceConnections}
          orgId={org.id}
          webBaseUrl={webBaseUrl}
        />
        <PromptCaptureCard canManage={canManage} orgId={org.id} />
      </div>
    </div>
  );
}
