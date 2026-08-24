// Catalog ranking: the blended order the storefront and the compare picker
// both use. Two questions, one feature space:
//
//   • Cold /models (no anchor) wants "preferred / frontier first" — the newest,
//     most capable models on top. That is `rankByFrontier`, and grouping the
//     result by family (first-seen order) makes the family with the strongest
//     model lead — the family-boosted default order the product owner asked for.
//   • The compare picker wants "everything ranked by similarity to the anchor"
//     (blend of size, release date, price, family-boosted). That is
//     `rankBySimilarity`.
//
// The blend runs over three observable proxies — price tier (a stand-in for
// capability/size, since the catalog carries no parameter count), context
// window (size), and release recency — each normalized across the visible
// catalog so no single axis dominates. Kept React-free and pure so the unit
// suite exercises the exact production ordering. Dollar/format math stays in
// format.ts and money.ts; this module only compares.

import { cheapestInputMicro } from "./format";
import { sameFamily } from "./families";
import type { CatalogEntry } from "./types";

/** Raw, un-normalized proxies for one model; null where the catalog is silent. */
type RawFeatures = {
  /** log10 of cheapest input micro-USD/M — the capability/size price proxy. */
  price: number | null;
  /** log10 of the context window in tokens — the size proxy. */
  context: number | null;
  /** Release date as epoch days — recency. */
  released: number | null;
};

const WEIGHTS = { price: 0.4, context: 0.25, released: 0.35 } as const;

// Same-family candidates are pulled together in the similarity order by
// scaling their distance down; a value under 1 means "treat same-family models
// as closer than their raw feature distance". Not zero — a wildly different
// sibling should still rank below a near twin from another family.
const FAMILY_SIMILARITY_FACTOR = 0.5;

// A preferred model is pinned above the organic frontier blend; the rank index
// (1 = most preferred) breaks ties among preferred models. The boost sits well
// clear of the 0..1 normalized blend so preferred always leads cold.
const PREFERRED_BOOST = 100;

function rawFeatures(entry: CatalogEntry): RawFeatures {
  const priceMicro = cheapestInputMicro(entry);
  const context = entry.model.context_window;
  const release = entry.model.release_date;
  const releasedDays =
    release === null ? null : Date.parse(`${release}T00:00:00Z`) / 86_400_000;
  return {
    price: priceMicro === null || priceMicro <= 0 ? null : Math.log10(priceMicro),
    context: context === null || context <= 0 ? null : Math.log10(context),
    released: releasedDays === null || Number.isNaN(releasedDays) ? null : releasedDays
  };
}

/** Median of the known values, used to impute a missing axis (0 if none known). */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

type Axis = keyof RawFeatures;
const AXES: Axis[] = ["price", "context", "released"];

/**
 * A normalization over the visible catalog: per-axis min/max and the median
 * that fills a missing value, so every model maps to a 0..1 vector on each
 * axis. Built once per ordering call and shared by frontier and similarity.
 */
type FeatureSpace = {
  vectors: Map<string, Record<Axis, number>>;
};

function buildFeatureSpace(entries: CatalogEntry[]): FeatureSpace {
  const raw = new Map<string, RawFeatures>();
  for (const entry of entries) {
    raw.set(entry.model.id, rawFeatures(entry));
  }
  const bounds = {} as Record<Axis, { min: number; max: number; median: number }>;
  for (const axis of AXES) {
    const known = [...raw.values()]
      .map((features) => features[axis])
      .filter((value): value is number => value !== null);
    bounds[axis] = {
      min: known.length === 0 ? 0 : Math.min(...known),
      max: known.length === 0 ? 1 : Math.max(...known),
      median: median(known)
    };
  }
  const vectors = new Map<string, Record<Axis, number>>();
  for (const [id, features] of raw) {
    const vector = {} as Record<Axis, number>;
    for (const axis of AXES) {
      const { min, max, median: mid } = bounds[axis];
      const value = features[axis] ?? mid;
      vector[axis] = max === min ? 0.5 : (value - min) / (max - min);
    }
    vectors.set(id, vector);
  }
  return { vectors };
}

/**
 * Frontier score: higher is newer / more capable / more preferred. Preferred
 * models are lifted clear of the organic blend so a cold catalog leads with
 * them; everything else ranks on the normalized price + context + recency mix.
 */
function frontierScore(entry: CatalogEntry, space: FeatureSpace): number {
  const vector = space.vectors.get(entry.model.id);
  const blend =
    vector === undefined
      ? 0
      : WEIGHTS.price * vector.price +
        WEIGHTS.context * vector.context +
        WEIGHTS.released * vector.released;
  const rank = entry.model.preferred_rank;
  if (rank !== null) {
    // Lower rank index = more preferred; keep the blend as the within-preferred
    // tiebreak so two preferred models still order sensibly.
    return PREFERRED_BOOST - rank + blend;
  }
  return blend;
}

/**
 * The cold-catalog order: frontier score descending, model id as a stable
 * final tiebreak so the order never depends on input order. Returns a new
 * array; the input is not mutated.
 */
export function rankByFrontier(entries: CatalogEntry[]): CatalogEntry[] {
  const space = buildFeatureSpace(entries);
  return [...entries].sort((a, b) => {
    const diff = frontierScore(b, space) - frontierScore(a, space);
    return diff !== 0 ? diff : a.model.id.localeCompare(b.model.id);
  });
}

function distance(
  a: Record<Axis, number>,
  b: Record<Axis, number>
): number {
  let sum = 0;
  for (const axis of AXES) {
    const delta = a[axis] - b[axis];
    sum += WEIGHTS[axis] * delta * delta;
  }
  return Math.sqrt(sum);
}

/**
 * Everything but the anchor, ordered by similarity to it: nearest first on the
 * blended feature distance, with same-family candidates pulled closer. Model id
 * breaks ties so the order is deterministic. Unknown anchors (a slug not in the
 * catalog) fall back to the frontier order — the picker still has a sane list.
 */
export function rankBySimilarity(
  entries: CatalogEntry[],
  anchor: CatalogEntry | null
): CatalogEntry[] {
  if (anchor === null) {
    return rankByFrontier(entries);
  }
  const space = buildFeatureSpace(entries);
  const anchorVector = space.vectors.get(anchor.model.id);
  if (anchorVector === undefined) {
    return rankByFrontier(entries).filter((entry) => entry.model.id !== anchor.model.id);
  }
  const scored = entries
    .filter((entry) => entry.model.id !== anchor.model.id)
    .map((entry) => {
      const vector = space.vectors.get(entry.model.id);
      const base = vector === undefined ? Number.POSITIVE_INFINITY : distance(anchorVector, vector);
      const scaled = sameFamily(anchor, entry) ? base * FAMILY_SIMILARITY_FACTOR : base;
      return { entry, score: scaled };
    });
  scored.sort((a, b) => {
    const diff = a.score - b.score;
    return diff !== 0 ? diff : a.entry.model.id.localeCompare(b.entry.model.id);
  });
  return scored.map((item) => item.entry);
}
