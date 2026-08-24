// Display rules for public benchmark scores (lib/models-catalog/types.ts
// ModelBenchmark). React-free so the formatting is unit-testable: percents
// show one decimal, arena Elo is an integer, benchmark-native points show one
// decimal. Provenance labels mirror the provenance.ts convention: every
// number says where it came from.

import type { ModelBenchmark, ModelDetail } from "./types";

/** The detail-only fields the compare board carries per selected model. */
export type ModelBenchmarkExtras = Pick<
  ModelDetail,
  "benchmarks" | "huggingface_url" | "release_url"
>;

/** One merged compare row: a benchmark with each model's score (if any). */
export type CompareBenchmarkRow = {
  benchmark: string;
  display_name: string;
  unit: ModelBenchmark["unit"];
  higher_is_better: boolean;
  scoreBySlug: Record<string, ModelBenchmark>;
};

/**
 * Union the selected models' benchmark lists into compare rows. Each model's
 * list arrives registry-ordered from the API; the union keeps that order by
 * sorting on the earliest index a benchmark holds in any list (ties by slug),
 * so registered benchmarks lead and unknown slugs trail alphabetically.
 * Models the extras map does not cover simply contribute no scores.
 */
export function mergeBenchmarkRows(
  slugs: string[],
  extrasBySlug: Record<string, ModelBenchmarkExtras>
): CompareBenchmarkRow[] {
  const rows = new Map<string, CompareBenchmarkRow & { order: number }>();
  for (const slug of slugs) {
    const benchmarks = extrasBySlug[slug]?.benchmarks ?? [];
    benchmarks.forEach((benchmark, index) => {
      const existing = rows.get(benchmark.benchmark);
      if (existing === undefined) {
        rows.set(benchmark.benchmark, {
          benchmark: benchmark.benchmark,
          display_name: benchmark.display_name,
          unit: benchmark.unit,
          higher_is_better: benchmark.higher_is_better,
          scoreBySlug: { [slug]: benchmark },
          order: index
        });
        return;
      }
      existing.scoreBySlug[slug] = benchmark;
      existing.order = Math.min(existing.order, index);
    });
  }
  return [...rows.values()]
    .sort((a, b) => a.order - b.order || a.benchmark.localeCompare(b.benchmark))
    .map(({ order: _order, ...row }) => row);
}

/**
 * Slugs whose score wins a merged row (the data-best highlight); empty below
 * two known values, mirroring the matrix's rule for catalog rows.
 */
export function bestBenchmarkSlugs(row: CompareBenchmarkRow, slugs: string[]): Set<string> {
  const known = slugs
    .map((slug) => ({ slug, score: row.scoreBySlug[slug]?.score }))
    .filter((item): item is { slug: string; score: number } => item.score !== undefined);
  if (known.length < 2) {
    return new Set();
  }
  const scores = known.map((item) => item.score);
  const target = row.higher_is_better ? Math.max(...scores) : Math.min(...scores);
  return new Set(known.filter((item) => item.score === target).map((item) => item.slug));
}

/** Format one score for display per its unit. */
export function formatBenchmarkScore(benchmark: ModelBenchmark): string {
  switch (benchmark.unit) {
    case "percent":
      return `${benchmark.score.toFixed(1)}%`;
    case "elo":
      return `${Math.round(benchmark.score)}`;
    case "points":
      return benchmark.score.toFixed(1);
  }
}

/** Human label for a score's source vocabulary value. */
export function benchmarkSourceLabel(source: string): string {
  switch (source) {
    case "vendor":
      return "vendor reported";
    case "huggingface":
      return "Hugging Face";
    case "lmarena":
      return "LMArena";
    case "leaderboard":
      return "public leaderboard";
    case "paper":
      return "paper";
    default:
      return source;
  }
}

/** Month + year the score was retrieved, e.g. "Aug 2026". */
export function formatRetrievedAt(retrievedAt: string): string {
  const date = new Date(retrievedAt);
  if (Number.isNaN(date.getTime())) {
    return retrievedAt;
  }
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
