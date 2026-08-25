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
 * One promo-repriced figure: a free promo is $0, a percent promo discounts the
 * known price, and an UNKNOWN price stays unknown — a promotion never turns
 * "unpriced" into "free". Lane scoping is the CALLER's job ({@link
 * promoEffectivePrice} feeds this only the price a covered lane supplies).
 */
export function promoEffectiveMicro(
  chip: PromoChip | null | undefined,
  micro: number | null
): number | null {
  if (chip === undefined || chip === null || micro === null) {
    return micro;
  }
  if (chip.kind === "free") {
    return 0;
  }
  return Math.round(micro * (1 - chip.percent_off / 100));
}

type PricedLane = { provider: string; micro: number | null };

/**
 * The honest price pair for a promoted model: `list` is the cheapest known
 * price across all lanes (what the catalog has always shown), `effective` is
 * the best price actually payable under the promo. An unscoped promo reprices
 * the list price; a LANE-SCOPED promo reprices only its covered lanes' best
 * price, and the effective floor is the cheaper of that and the undiscounted
 * list price — a discount on one lane never repricing an unrelated route, and
 * a covered cheapest lane never losing its discount. Ranking, sorting, and
 * best-value highlighting must feed `effective`.
 */
export function promoEffectivePrice(
  chip: PromoChip | null | undefined,
  lanes: PricedLane[]
): { list: number | null; effective: number | null } {
  const known = (values: Array<number | null>): number | null => {
    const priced = values.filter((value): value is number => value !== null);
    return priced.length === 0 ? null : Math.min(...priced);
  };
  const list = known(lanes.map((lane) => lane.micro));
  if (chip === undefined || chip === null || list === null) {
    return { list, effective: list };
  }
  if (chip.providers.length === 0) {
    return { list, effective: promoEffectiveMicro(chip, list) };
  }
  const covered = known(
    lanes.filter((lane) => chip.providers.includes(lane.provider)).map((lane) => lane.micro)
  );
  const discounted = promoEffectiveMicro(chip, covered);
  return { list, effective: discounted === null ? list : Math.min(list, discounted) };
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
