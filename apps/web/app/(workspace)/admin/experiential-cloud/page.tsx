import {
  ExperientialCloudBrowse,
  type ExperientialCloudModelOption
} from "@/components/admin/ExperientialCloudBrowse";
import { getDataSource } from "@/lib/data-source";
import { fetchPublicCatalog } from "@/lib/models-catalog/server";

export const metadata = { title: "Admin · Experiential Cloud" };

export const dynamic = "force-dynamic";

/**
 * The Experiential Cloud section: attach the platform's native vLLM lanes (on
 * Kion GPUs) to specific public models, price them, and turn each lane ON/OFF.
 * A lane is one model_providers row with provider = "experiential_cloud"; ON is
 * status "active", OFF is "disabled". This surface is the runtime authority for
 * EC lanes, replacing the hardcoded-seed approach — attach a lane staged OFF
 * and flip it ON at a moment's notice. The upstream bearer stays a worker
 * secret and is never stored in the catalog; only the endpoint is set here. The
 * eyebrow and section tabs (and the platform-admin gate) come from the admin
 * layout above. The public catalog rides along so the attach form can pick a
 * model; the backend re-validates.
 */
export default async function AdminExperientialCloudPage() {
  const [list, catalog] = await Promise.all([
    getDataSource().listAdminExperientialCloud(),
    fetchPublicCatalog()
  ]);
  const models: ExperientialCloudModelOption[] = catalog.models.map((entry) => ({
    slug: entry.model.slug,
    display_name: entry.model.display_name
  }));
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ink">Experiential Cloud</h1>
        <p className="mt-2 max-w-[820px] text-sm leading-relaxed text-muted">
          Experiential Cloud is our native vLLM served on Kion GPUs. Attach a lane to a public
          model, set its endpoint and prices, and turn it ON or OFF. A new lane is staged OFF
          (never serving) so you can wire it ahead of time and flip it ON at a moment&apos;s notice;
          turning it ON routes real traffic. The endpoint is set per lane here, but the upstream
          API key is a worker secret (managed in deploy config) and is never stored in the catalog.
          This panel is platform-admin only.
        </p>
      </div>
      <ExperientialCloudBrowse
        deployments={list.deployments}
        models={models}
        workerBaseUrlConfigured={list.worker_base_url_configured}
      />
    </div>
  );
}
