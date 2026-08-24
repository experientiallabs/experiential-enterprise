// Server-side slug vocabulary for usage surfaces that link aliases out to
// /models/{slug}. A usage rollup alias IS the routable model slug, but a
// delisted or renamed model can survive in usage history — so link targets are
// gated on the catalog actually knowing the slug today.

import { fetchPublicCatalog } from "@/lib/models-catalog/server";

/**
 * Every slug in the shared public catalog (a warm cross-request cache read —
 * no per-visit backend round trip), or null when the catalog is unavailable.
 * Callers fail OPEN on null (link everything) so a catalog hiccup degrades to
 * the occasional dead link rather than stripping navigation. Org-custom models
 * are not in the shared cache; their rows simply do not link.
 */
export async function catalogModelSlugs(): Promise<string[] | null> {
  try {
    const catalog = await fetchPublicCatalog();
    return catalog.models.map((entry) => entry.model.slug);
  } catch {
    return null;
  }
}
