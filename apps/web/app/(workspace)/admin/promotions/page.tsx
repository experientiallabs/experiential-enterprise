import { Info } from "lucide-react";

import { PromotionsBrowse, type PromotionModelOption } from "@/components/admin/PromotionsBrowse";
import {
  RecommendedModelsCard,
  type RecommendedModelOption
} from "@/components/admin/RecommendedModelsCard";
import { getDataSource } from "@/lib/data-source";
import { modelFamilyKey } from "@/lib/models-catalog/families";
import { fetchPublicCatalog } from "@/lib/models-catalog/server";

export const metadata = { title: "Admin — Promotions" };

export const dynamic = "force-dynamic";

/**
 * The Promotions section: the platform's catalog-curation surface. Two cards:
 * labeled promotional scopes the gateway funds on preferential terms, and the
 * Recommended set (the starred, front-of-catalog band every model picker
 * surfaces first). Admins target promotion scopes (models, families, provider
 * lanes) with money terms, and drag-reorder/replace the recommended list,
 * which saves as one whole-set PUT. The eyebrow and section tabs come from the
 * admin layout above (which already gates on platform-admin); promotion
 * enforcement lives in the gateway, and the recommended ranks live on
 * public.models. The public catalog rides along so both cards can
 * expand/validate slugs client-side (the backend re-validates). The mechanics
 * live in Info tooltips so the headings stay one line each.
 */
export default async function AdminPromotionsPage() {
  const [promotions, recommended, catalog] = await Promise.all([
    getDataSource().listAdminModelPromotions(),
    getDataSource().listAdminRecommendedModels(),
    fetchPublicCatalog()
  ]);
  const models: PromotionModelOption[] = catalog.models.map((entry) => ({
    slug: entry.model.slug,
    display_name: entry.model.display_name,
    familyKey: modelFamilyKey(entry)
  }));
  const recommendedOptions: RecommendedModelOption[] = models.map(
    ({ slug, display_name }) => ({ slug, display_name })
  );
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center gap-1.5">
          <h1 className="m-0 text-xl font-semibold text-ink">Promotions</h1>
          <span
            aria-label="About promotions"
            className="inline-flex cursor-help text-muted-2"
            title={
              "A promotion targets models, families, or provider lanes. The per-org free cap " +
              "is spent free; once reached (or from the first request when it is $0) the " +
              "percent discount applies to credit spend, up to the discount cap and only " +
              "through the selected providers when provider-scoped."
            }
          >
            <Info aria-hidden size={13} strokeWidth={1.8} />
          </span>
        </div>
        <p className="mt-1 text-sm text-muted">Scoped terms the platform funds.</p>
      </div>
      <PromotionsBrowse models={models} promotions={promotions} />
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className="m-0 text-lg font-semibold text-ink">Recommended models</h2>
          <span
            aria-label="About recommended models"
            className="inline-flex cursor-help text-muted-2"
            title={
              "The starred set that leads the catalog and every model picker. Other public " +
              "models stay listed in their folded provider sections. The seed only provides " +
              "defaults on a fresh database; a re-seed never overwrites this list."
            }
          >
            <Info aria-hidden size={13} strokeWidth={1.8} />
          </span>
        </div>
        <p className="mt-1 text-sm text-muted">Drag to reorder. Top shows first.</p>
      </div>
      <RecommendedModelsCard models={recommendedOptions} recommended={recommended} />
    </div>
  );
}
