import { AdminTelemetryPanel } from "@/components/admin/AdminTelemetryPanel";
import { listAdministeredOrgNames } from "@/lib/admin/orgs-server";

export const metadata = { title: "Admin telemetry" };

export const dynamic = "force-dynamic";

/**
 * The Telemetry section: the gateway usage rollup at the operator altitude —
 * every organization summed, plus a per-org breakdown that drills into one
 * org's series. The admin layout above gates the whole segment to platform
 * operators (a non-admin gets not-found); the panel reads the gated admin
 * usage API and reuses the Overview page's chart and section components. The
 * id → name roster is fetched here so the breakdown can name orgs without a
 * second client read.
 */
export default async function AdminTelemetryPage() {
  const orgs = await listAdministeredOrgNames();
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ink">Platform telemetry</h1>
        <p className="mt-2 max-w-[780px] text-sm leading-relaxed text-muted">
          Gateway usage across every organization: requests, tokens, and spend as one platform
          total, broken down per org, with drilldown into any single organization. Customers never
          see this.
        </p>
      </div>
      <AdminTelemetryPanel orgs={orgs} />
    </div>
  );
}
