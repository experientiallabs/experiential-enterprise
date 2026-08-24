import { DemoBanner } from "@/components/telemetry-page/demo-banner";
import { TelemetryView } from "@/components/telemetry-page/telemetry-view";
import { publicServingBaseUrl } from "@/components/world-models/endpoint-snippets";
import { resolveActiveOrg } from "@/lib/active-org";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import {
  parseTelemetryView,
  usageRequestsQueryFromView,
  type TelemetryViewState
} from "@/lib/gateway-telemetry";
import { demoByKey, demoByProvider, demoRequests, demoTimeseries } from "@/lib/telemetry-demo";
import type { ImportedUsage } from "@/lib/types";

export const metadata = { title: "Logs" };

export const dynamic = "force-dynamic";

const EMPTY_IMPORTED_USAGE: ImportedUsage = {
  models: [],
  totals: {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0
  }
};

type TelemetryPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The single home for usage display: spend over both money lanes, usage by
 * model, usage per agent (an agent = an organization API key), and the
 * per-request gateway log — one no-scroll page that fills the viewport, every
 * section driven by one filter bar. Data comes from the gateway usage ledger's
 * tenant read endpoints (explabs/api/routes/gateway_usage.py). The page is
 * public: a signed-out visitor gets the same page over clearly-labeled demo
 * data, and only seeing their OWN usage requires logging in.
 */
export default async function TelemetryPage({ searchParams }: TelemetryPageProps) {
  const initialView: TelemetryViewState = parseTelemetryView(await searchParams);
  const user = await getAuthenticatedUser();
  if (user === null) {
    return <DemoTelemetryPage initialView={initialView} />;
  }
  const org = await resolveActiveOrg();
  const source = getDataSource();
  const [timeseries, byKey, byProvider, page, imported, firstCall] = await Promise.all([
    source.getUsageTimeseries(org.id, {
      window: initialView.window,
      model: initialView.model ?? undefined,
      apiKeyId: initialView.agentId ?? undefined,
      lane: initialView.lane ?? undefined
    }),
    source.getUsageByKey(org.id, initialView.window),
    source.getUsageByProvider(org.id, initialView.window),
    source.listUsageRequests(org.id, usageRequestsQueryFromView(initialView)),
    loadImportedUsage(source, org.id),
    resolveFirstCall(org.id)
  ]);

  return (
    <TelemetryView
      // Re-mount when a deep link lands on an already-rendered page, so
      // fresh searchParams actually replace the client view state.
      key={`${initialView.window}|${initialView.model ?? ""}|${initialView.agentId ?? ""}|${initialView.lane ?? ""}|${initialView.errorsOnly}`}
      firstCall={firstCall}
      initialByKey={byKey}
      initialByProvider={byProvider}
      initialCursor={page.next_cursor}
      initialImported={imported}
      initialRequests={page.requests}
      initialTimeseries={timeseries}
      initialView={initialView}
      nowMs={Date.now()}
      orgId={org.id}
    />
  );
}

/**
 * The signed-out page: the full Telemetry surface over the deterministic
 * demo dataset, rendered through the exact same components as real data.
 * No account-scoped fetch fires; the header carries the "Demo data" chip and
 * the login CTA, and signing in swaps in real data with no layout shift.
 */
function DemoTelemetryPage({ initialView }: { initialView: TelemetryViewState }) {
  const nowMs = Date.now();
  const page = demoRequests(usageRequestsQueryFromView(initialView), nowMs);
  return (
    <TelemetryView
      key={`${initialView.window}|${initialView.model ?? ""}|${initialView.agentId ?? ""}|${initialView.lane ?? ""}|${initialView.errorsOnly}`}
      banner={<DemoBanner />}
      demo
      firstCall={null}
      initialByKey={demoByKey(initialView.window, nowMs)}
      initialByProvider={demoByProvider(initialView.window, nowMs)}
      initialCursor={page.next_cursor}
      initialRequests={page.requests}
      initialTimeseries={demoTimeseries(
        {
          window: initialView.window,
          model: initialView.model ?? undefined,
          apiKeyId: initialView.agentId ?? undefined,
          lane: initialView.lane ?? undefined
        },
        nowMs
      )}
      initialView={initialView}
      nowMs={nowMs}
      orgId="demo"
    />
  );
}

/**
 * Imported historical spend is a secondary Logs panel. A timeout or store
 * failure must not blank the rest of the page: return a typed zero rollup
 * (the section already hides itself when models is empty) and log the error.
 */
async function loadImportedUsage(
  source: { getImportedUsage: (orgId: string) => Promise<ImportedUsage> },
  orgId: string
): Promise<ImportedUsage> {
  try {
    return await source.getImportedUsage(orgId);
  } catch (error) {
    console.error(`Failed to load imported usage for org ${orgId}`, error);
    return EMPTY_IMPORTED_USAGE;
  }
}

/**
 * The model the never-used state offers as the first call: a serving Project
 * when one exists (any Project otherwise, its page explains readiness).
 * Degrades to the create door (null) rather than failing the page.
 */
async function resolveFirstCall(
  orgId: string
): Promise<{ modelName: string; baseUrl: string } | null> {
  try {
    const source = getDataSource();
    const page = await source.listProjects(orgId, { limit: 24 });
    const results = await Promise.all(
      page.projects.map(async (project) => {
        try {
          const result = await source.getProjectResult(project.id);
          return { project, active: result.active };
        } catch {
          return { project, active: false };
        }
      })
    );
    const pick = results.find((row) => row.active) ?? results[0];
    return pick !== undefined
      ? { modelName: pick.project.slug, baseUrl: publicServingBaseUrl() }
      : null;
  } catch (error) {
    console.error(`Failed to resolve a first-call model for org ${orgId}`, error);
    return null;
  }
}
