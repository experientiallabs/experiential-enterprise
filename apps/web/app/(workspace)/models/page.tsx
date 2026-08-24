import Link from "next/link";

import { CatalogTable } from "@/components/models-catalog/catalog-table";
import { buttonClassName } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorTile } from "@/components/ui/ErrorTile";
import { resolveActiveOrgForTelemetry } from "@/lib/active-org";
import { createServerSupabaseClient, getAuthenticatedUser } from "@/lib/auth/server";
import { fetchOrgOwnedModels, fetchPublicCatalog } from "@/lib/models-catalog/server";

export const metadata = { title: "Models" };

// Request-time render: the catalog itself is a warm shared-cache read
// (fetchPublicCatalog / unstable_cache), plus the small provider-gate reads
// below (session, active org, the org's connected-provider list, and, only
// while no provider is connected, the org model overlay). The signed-in org
// overlay for the table still hydrates CLIENT-side in CatalogTable.
export const dynamic = "force-dynamic";

// Provider gate: the storefront lists only models the org can actually call.
// A model is callable when it has a deployment on a provider the org has
// CONNECTED, or when the org owns the model row itself (custom/local rows
// need no connection). The seeded host_managed routes deliberately do NOT
// count: this deployment ships no house provider credentials. With no
// connection and no own model, the whole catalog stays behind the
// connect-a-provider prompt; signed-out viewers see the same prompt. This
// gates DISPLAY only; the seeded rows, alias activation, and gateway
// readiness are untouched, and model detail URLs stay reachable directly.
type ProviderGate = {
  /**
   * The org's provider_connections.provider values. Same vocabulary as
   * CatalogDeployment.provider (both use the canonical MODEL_PROVIDERS
   * tokens, azure_openai included), so plain equality decides callability.
   */
  connectedProviders: Set<string>;
  orgOwnsModels: boolean;
};

async function resolveProviderGate(): Promise<ProviderGate | null> {
  const user = await getAuthenticatedUser();
  if (user === null) {
    return null;
  }
  const org = await resolveActiveOrgForTelemetry();
  if (org === null) {
    return null;
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("provider_connections")
    .select("provider")
    .eq("org_id", org.id);
  if (error !== null) {
    return null;
  }
  const connectedProviders = new Set(
    ((data ?? []) as { provider: string }[]).map((row) => row.provider)
  );
  if (connectedProviders.size > 0) {
    // Already unlocked; org-owned rows ride the filter's owning arm and the
    // client-side overlay, so the extra backend read is skipped.
    return { connectedProviders, orgOwnsModels: false };
  }
  const own = await fetchOrgOwnedModels(user.id);
  return { connectedProviders, orgOwnsModels: own.models.length > 0 };
}

/**
 * The model catalog — the storefront and the signed-out door at "/".
 *
 * The catalog paints only once the provider gate opens; until then this page
 * is the connect-a-provider prompt plus the door to the add-a-model form, the
 * two ways to make a request routable. Once open, the org-agnostic public
 * catalog is served from a shared cross-user cache (fetchPublicCatalog), so
 * every visit paints the last-good catalog instantly with no per-visit
 * refetch and no loading flash, while a background revalidation picks up new
 * models for everyone. A signed-in viewer's own custom models are overlaid
 * CLIENT-side (CatalogTable hydrates them from GET /api/models?owner=org
 * after paint), so they never block the first render. Rendered as one client
 * table where every filter, sort, view switch, and compare selection is
 * instant. No page title and no page scroll: the toolbar is the top edge and
 * the table scrolls inside its own frame.
 */
export default async function ModelsPage() {
  let catalog;
  try {
    catalog = await fetchPublicCatalog();
  } catch {
    return (
      <div className="flex h-full min-h-0 flex-col gap-5">
        <ErrorTile
          message="The model catalog is unreachable right now. Reload to retry."
          title="Catalog unavailable"
        />
      </div>
    );
  }
  let gate: ProviderGate | null = null;
  try {
    gate = await resolveProviderGate();
  } catch {
    // Fail closed: an undecidable gate must not display the catalog.
  }
  if (gate === null || (gate.connectedProviders.size === 0 && !gate.orgOwnsModels)) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4">
        <EmptyState
          body="Sign in and add a provider API key in Settings under Connections, or register a model you host yourself. Models appear here once a request can be routed to one."
          title="Connect a provider to see models"
        />
        <div className="flex justify-center">
          {/* The gate hides CatalogTable's toolbar, which holds the only other
              link to this form — and registering an owned model is one of the
              two ways to open the gate, so the door has to stay reachable. */}
          <Link className={buttonClassName("accent", undefined, "sm")} href="/models/new">
            Add model
          </Link>
        </div>
      </div>
    );
  }
  // Only callable models display: a deployment on a connected provider, or
  // the org's own row. Promotions pass through whole; CatalogTable drops the
  // ones whose model is not in the entry set.
  const connected = gate.connectedProviders;
  const visible = catalog.models.filter(
    (entry) =>
      entry.model.owning_org_id !== null ||
      entry.providers.some((deployment) => connected.has(deployment.provider))
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CatalogTable entries={visible} hydrateOrgModels promotions={catalog.promotions} />
    </div>
  );
}
