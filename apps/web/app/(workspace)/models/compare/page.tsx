import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { CompareBoard } from "@/components/models-catalog/compare-board";
import { COMPARE_LIMIT } from "@/components/models-catalog/filtering";
import { ErrorTile } from "@/components/ui/ErrorTile";
import type { ModelBenchmarkExtras } from "@/lib/models-catalog/benchmarks";
import { fetchModelDetail, fetchModelList } from "@/lib/models-catalog/server";
import { modelsPath } from "@/lib/routes";

export const metadata = { title: "Compare models" };

export const dynamic = "force-dynamic";

/**
 * Side-by-side comparison, URL-driven: /models/compare?models=a,b,c (2–4).
 * Public and server-rendered from the query string, so a shared deep link
 * renders cold. Entry points: the detail page's Compare button and the
 * catalog table's multi-select.
 */
export default async function CompareModelsPage({
  searchParams
}: {
  searchParams: Promise<{ models?: string | string[] }>;
}) {
  const { models } = await searchParams;
  // Canonical form is one comma-joined param; a repeated ?models=a&models=b
  // (hand-typed) arrives as an array and folds into the same list.
  const raw = Array.isArray(models) ? models.join(",") : (models ?? "");
  const selectedSlugs = [
    // De-duplicated: ?models=a,a would render one model as two columns (and
    // collide as React keys).
    ...new Set(
      raw
        .split(",")
        .map((slug) => decodeURIComponent(slug.trim()))
        .filter((slug) => slug.length > 0)
    )
  ].slice(0, COMPARE_LIMIT);

  let catalog;
  let extras: Record<string, ModelBenchmarkExtras>;
  try {
    // Benchmarks + HF/release links ride the detail payload only, so prefetch
    // them for the deep-linked selection alongside the catalog (concurrent;
    // fetchSelectedExtras never throws - a failed detail read just leaves that
    // column's benchmark cells empty).
    [catalog, extras] = await Promise.all([
      fetchModelList(),
      fetchSelectedExtras(selectedSlugs)
    ]);
  } catch {
    return (
      <div className="flex h-full min-h-0 flex-col gap-5">
        <CompareHeader />
        <ErrorTile
          message="The model catalog is unreachable right now. Reload to retry."
          title="Catalog unavailable"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <CompareHeader />
      <CompareBoard entries={catalog.models} initialExtras={extras} selectedSlugs={selectedSlugs} />
    </div>
  );
}

/** Best-effort detail prefetch for the deep-linked selection; never throws. */
async function fetchSelectedExtras(
  slugs: string[]
): Promise<Record<string, ModelBenchmarkExtras>> {
  const pairs = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const detail = await fetchModelDetail(slug);
        if (detail === null) {
          return null;
        }
        return [
          slug,
          {
            benchmarks: detail.benchmarks ?? [],
            huggingface_url: detail.huggingface_url ?? null,
            release_url: detail.release_url ?? null
          }
        ] as const;
      } catch {
        return null;
      }
    })
  );
  return Object.fromEntries(pairs.filter((pair) => pair !== null));
}

function CompareHeader() {
  return (
    <div className="shrink-0">
      <Link
        className="mb-3 inline-flex w-fit items-center gap-1.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
        href={modelsPath()}
      >
        <ArrowLeft aria-hidden size={13} strokeWidth={1.8} />
        Models
      </Link>
      <h1 className="m-0 text-xl font-semibold text-ink">Compare models</h1>
      <p className="mt-2 max-w-[780px] text-[13px] leading-relaxed text-muted">
        Prices, context, capabilities, and providers side by side. The best value per row is
        highlighted.
      </p>
    </div>
  );
}
