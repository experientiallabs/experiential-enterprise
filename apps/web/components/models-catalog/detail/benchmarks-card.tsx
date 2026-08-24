// Public benchmark scores + the model's canonical external link (Hugging Face
// repo for open weights, the official release page otherwise), on the model
// detail's left column. Server-rendered, condensed: one row per score with
// its provenance (source + retrieved date) linked to the citation, mirroring
// the provenance rule that no catalog number renders without its source.
// Renders nothing when the model has neither scores nor a link.

import { ExternalLink } from "lucide-react";

import {
  benchmarkSourceLabel,
  formatBenchmarkScore,
  formatRetrievedAt
} from "@/lib/models-catalog/benchmarks";
import type { ModelBenchmark } from "@/lib/models-catalog/types";

type BenchmarksCardProps = {
  benchmarks: ModelBenchmark[];
  huggingfaceUrl: string | null;
  releaseUrl: string | null;
};

export function BenchmarksCard({ benchmarks, huggingfaceUrl, releaseUrl }: BenchmarksCardProps) {
  const href = huggingfaceUrl ?? releaseUrl;
  if (benchmarks.length === 0 && href === null) {
    return null;
  }
  const linkLabel = huggingfaceUrl !== null ? "Hugging Face" : "Release notes";
  return (
    <section
      className="rounded-lg border border-line bg-surface"
      data-testid="benchmarks-card"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <p className="mono-label m-0">{benchmarks.length > 0 ? "Benchmarks" : "Model"}</p>
        {href !== null ? (
          <a
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-muted transition-colors hover:text-ink"
            data-testid="model-external-link"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            {linkLabel}
            <ExternalLink aria-hidden size={11} strokeWidth={1.8} />
          </a>
        ) : null}
      </div>
      {benchmarks.length > 0 ? (
        <ul className="m-0 list-none border-t border-line p-0">
          {benchmarks.map((benchmark) => {
            const provenance = `${benchmarkSourceLabel(benchmark.source)} · ${formatRetrievedAt(
              benchmark.retrieved_at
            )}`;
            return (
              <li
                className="flex min-h-[34px] items-center gap-3 border-b border-line px-4 py-1.5 last:border-b-0"
                data-testid="benchmark-row"
                key={benchmark.benchmark}
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-soft">
                  {benchmark.display_name}
                </span>
                {benchmark.source_url !== null ? (
                  <a
                    className="shrink-0 font-mono text-[10.5px] text-muted-2 transition-colors hover:text-ink"
                    href={benchmark.source_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {provenance}
                  </a>
                ) : (
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-2">
                    {provenance}
                  </span>
                )}
                <span className="w-14 shrink-0 text-right font-mono text-[12.5px] font-semibold text-ink">
                  {formatBenchmarkScore(benchmark)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
