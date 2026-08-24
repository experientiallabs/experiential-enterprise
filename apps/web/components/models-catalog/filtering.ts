// Pure filter logic for the catalog page. The whole catalog ships to the
// client (hundreds of rows, one fetch), so every filter interaction is a pure
// recompute here — no server round-trips, no loading states. Kept free of
// React so the unit suite exercises the exact production predicates.

import {
  bestThroughput,
  cheapestInputMicro,
  hasCacheDiscount,
  providerLabel
} from "@/lib/models-catalog/format";
import { pinExperientialCloudFirst } from "@/lib/models-catalog/serving";
import type { CatalogDeployment, CatalogEntry } from "@/lib/models-catalog/types";

/** "models" = one row per model; "routes" = one row per provider route. */
export type CatalogView = "models" | "routes";

/**
 * Compare capacity, shared by the catalog multi-select, the compare board,
 * and the compare PAGE. Lives in this plain module on purpose: a constant
 * imported from a "use client" module into a server component arrives as a
 * client-reference stub, not a number — slicing by it silently empties the
 * URL's model list.
 */
export const COMPARE_LIMIT = 4;

export type CatalogFilterState = {
  query: string;
  /** Input modalities the model must all accept. */
  modalities: string[];
  /** Providers; a model passes when ANY of its routes matches. */
  providers: string[];
  /** supported_params keys that must be true. */
  params: string[];
  category: string | null;
  minContext: number | null;
  /** Max input price, micro-USD per million tokens (cheapest route counts). */
  maxInputMicro: number | null;
  /** Cache-discounted routes only (cached-input price < input price). */
  discountsOnly: boolean;
  /** Model age cap in days from `now`; needs a known release date. */
  maxAgeDays: number | null;
};

export const EMPTY_FILTERS: CatalogFilterState = {
  query: "",
  modalities: [],
  providers: [],
  params: [],
  category: null,
  minContext: null,
  maxInputMicro: null,
  discountsOnly: false,
  maxAgeDays: null
};

export function countActiveFilters(state: CatalogFilterState): number {
  return (
    (state.query.trim() === "" ? 0 : 1) +
    state.modalities.length +
    state.providers.length +
    state.params.length +
    (state.category === null ? 0 : 1) +
    (state.minContext === null ? 0 : 1) +
    (state.maxInputMicro === null ? 0 : 1) +
    (state.discountsOnly ? 1 : 0) +
    (state.maxAgeDays === null ? 0 : 1)
  );
}

/** One row of the expanded per-route view ("Claude by Anthropic or Bedrock"). */
export type RouteRow = {
  entry: CatalogEntry;
  deployment: CatalogDeployment;
};

export function entryMatches(
  entry: CatalogEntry,
  state: CatalogFilterState,
  now: Date
): boolean {
  const { model } = entry;
  const query = state.query.trim().toLowerCase();
  if (query !== "") {
    const haystack = [
      model.display_name,
      model.slug,
      model.category ?? "",
      ...model.tags,
      ...entry.providers.map((row) => providerLabel(row.provider)),
      ...entry.providers.map((row) => row.provider_model_id)
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }
  if (state.modalities.some((modality) => !model.input_modalities.includes(modality))) {
    return false;
  }
  if (
    state.providers.length > 0 &&
    !entry.providers.some((row) => state.providers.includes(row.provider))
  ) {
    return false;
  }
  if (state.params.some((param) => model.supported_params[param] !== true)) {
    return false;
  }
  if (state.category !== null && model.category !== state.category) {
    return false;
  }
  if (
    state.minContext !== null &&
    (model.context_window === null || model.context_window < state.minContext)
  ) {
    return false;
  }
  if (state.maxInputMicro !== null) {
    const cheapest = cheapestInputMicro(entry);
    if (cheapest === null || cheapest > state.maxInputMicro) {
      return false;
    }
  }
  if (state.discountsOnly && !entry.providers.some(hasCacheDiscount)) {
    return false;
  }
  if (state.maxAgeDays !== null) {
    if (model.release_date === null) {
      return false;
    }
    const released = new Date(`${model.release_date}T00:00:00Z`).getTime();
    const ageDays = (now.getTime() - released) / 86_400_000;
    if (ageDays > state.maxAgeDays) {
      return false;
    }
  }
  return true;
}

export function filterEntries(
  entries: CatalogEntry[],
  state: CatalogFilterState,
  now: Date = new Date()
): CatalogEntry[] {
  return entries.filter((entry) => entryMatches(entry, state, now));
}

/**
 * Expand matching models into per-route rows. Provider and discount filters
 * narrow the routes themselves here — that is the whole point of the view.
 */
export function filterRoutes(
  entries: CatalogEntry[],
  state: CatalogFilterState,
  now: Date = new Date()
): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const entry of filterEntries(entries, state, now)) {
    for (const deployment of pinExperientialCloudFirst(entry.providers)) {
      if (state.providers.length > 0 && !state.providers.includes(deployment.provider)) {
        continue;
      }
      if (state.discountsOnly && !hasCacheDiscount(deployment)) {
        continue;
      }
      rows.push({ entry, deployment });
    }
  }
  return rows;
}

/** Distinct categories present in the catalog, for the filter menu. */
export function catalogCategories(entries: CatalogEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.model.category !== null) {
      seen.add(entry.model.category);
    }
  }
  return [...seen].sort();
}

/** Distinct providers with at least one route, for the filter menu. */
export function catalogProviders(entries: CatalogEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const deployment of entry.providers) {
      seen.add(deployment.provider);
    }
  }
  return [...seen].sort();
}

/** Best throughput as a sort accessor for the models view. */
export function throughputSortValue(entry: CatalogEntry): number | null {
  return bestThroughput(entry);
}
