// Promo-chip ranking: which single chip a catalog model wears when several
// active promotions cover it. Kept free of React (like families.ts/ranking.ts)
// so the storefront rows, the admin panel rows, and the unit suite share the
// exact resolution the UI renders.

import type { ModelPromotion } from "./types";

/** The one chip a model wears; `providers` is the promo's lane scope. */
export type PromoChip =
  | { kind: "free"; providers: string[] }
  | { kind: "percent"; percent_off: number; providers: string[] };

/**
 * Rank the active promotions covering ONE slug down to its single chip.
 * Precedence mirrors the gateway's own resolution, where a usable free tier
 * outranks a discount: (a) a free promo beats a percent promo; (b) among free
 * promos the lowest display_order wins; (c) among percent promos the highest
 * percent_off wins, then the lowest display_order. Returns null when nothing
 * chip-worthy covers the slug.
 */
export function rankPromosForSlug(promos: ModelPromotion[]): PromoChip | null {
  const free = promos
    .filter((promo) => promo.free)
    .sort((a, b) => a.display_order - b.display_order)[0];
  if (free !== undefined) {
    return { kind: "free", providers: free.providers };
  }
  const percent = promos
    .filter((promo) => promo.percent_off > 0)
    .sort((a, b) => b.percent_off - a.percent_off || a.display_order - b.display_order)[0];
  if (percent !== undefined) {
    return { kind: "percent", percent_off: percent.percent_off, providers: percent.providers };
  }
  return null;
}

/**
 * slug -> its one ranked chip, over the whole active promotion set — the O(1)
 * per-row lookup the catalog table memoizes for its render hot path.
 */
export function promoChipsBySlug(promotions: ModelPromotion[]): Map<string, PromoChip> {
  const promosBySlug = new Map<string, ModelPromotion[]>();
  for (const promo of promotions) {
    for (const slug of promo.slugs) {
      const list = promosBySlug.get(slug);
      if (list !== undefined) {
        list.push(promo);
      } else {
        promosBySlug.set(slug, [promo]);
      }
    }
  }
  const chips = new Map<string, PromoChip>();
  for (const [slug, promos] of promosBySlug) {
    const chip = rankPromosForSlug(promos);
    if (chip !== null) {
      chips.set(slug, chip);
    }
  }
  return chips;
}
