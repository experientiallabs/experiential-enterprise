// Brand identity for bare usage aliases. The usage rollups carry only the
// alias string (the routable model slug the gateway resolved), never a catalog
// row, so usage surfaces derive the maker key ModelIcon paints from the same
// name rules the catalog uses — one vocabulary, no second regex table.

import { modelIconKey } from "@/lib/models-catalog/families";
import type { CatalogModel } from "@/lib/models-catalog/types";

/**
 * The maker/family icon key for a usage alias. The catalog's family derivation
 * reads only {icon, display_name, slug}; the alias stands in for both name and
 * slug, and the null icon lets the name rules decide (a maker with no mark
 * falls back to ModelIcon's monogram tile).
 */
export function aliasIconKey(alias: string): string {
  const probe: Pick<CatalogModel, "icon" | "display_name" | "slug"> = {
    icon: null,
    display_name: alias,
    slug: alias
  };
  return modelIconKey(probe as CatalogModel);
}
