"use client";

// The compare screen. You pick models the exact way you browse them: the same
// sortable, filterable catalog table, in compare-select mode. The chosen models
// then render side by side above it. URL-driven (?models=a,b,c), so a deep link
// renders cold and every edit is shareable. Public, like the rest of the
// catalog.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Gamepad2, X } from "lucide-react";
import { clsx } from "clsx";

import { buttonClassName } from "@/components/ui/Button";

import { ModalityIcons, ParamChips, ProviderBadge } from "./badges";
import { ModelIcon } from "./model-icon";
import { CatalogTable } from "./catalog-table";
import { COMPARE_LIMIT } from "./filtering";
import { modelIconKey } from "@/lib/models-catalog/families";
import {
  bestThroughput,
  bestUptime,
  cheapestInputMicro,
  cheapestOutputMicro,
  formatReleaseDate,
  formatThroughput,
  formatTokenCount,
  formatUptime,
  supportedParamList
} from "@/lib/models-catalog/format";
import { formatPerMillionUsd } from "@/lib/money";
import {
  benchmarkSourceLabel,
  bestBenchmarkSlugs,
  formatBenchmarkScore,
  formatRetrievedAt,
  mergeBenchmarkRows,
  type ModelBenchmarkExtras
} from "@/lib/models-catalog/benchmarks";
import { pinExperientialCloudFirst } from "@/lib/models-catalog/serving";
import { modelPath, playgroundComparePath } from "@/lib/routes";
import type { CatalogEntry, ModelDetail } from "@/lib/models-catalog/types";

type CompareBoardProps = {
  /** The whole visible catalog: the comparison data and the picker's rows. */
  entries: CatalogEntry[];
  /** Slugs from the URL, in order; unknown slugs are ignored. */
  selectedSlugs: string[];
  /**
   * Detail-only fields (benchmarks + HF/release links) the server prefetched
   * for the deep-linked selection; models toggled in later lazily load theirs
   * through the public detail route.
   */
  initialExtras?: Record<string, ModelBenchmarkExtras>;
};

/** A compare row: label, value renderer, and what "best" means (if numeric). */
type CompareRow = {
  id: string;
  label: string;
  value: (entry: CatalogEntry) => React.ReactNode;
  /** Numeric accessor for best-value detection; null values never win. */
  metric?: (entry: CatalogEntry) => number | null;
  best?: "min" | "max";
};

const ROWS: CompareRow[] = [
  {
    id: "input",
    label: "Input $/M",
    metric: cheapestInputMicro,
    best: "min",
    value: (entry) => <Mono>{formatPerMillionUsd(cheapestInputMicro(entry))}</Mono>
  },
  {
    id: "output",
    label: "Output $/M",
    metric: cheapestOutputMicro,
    best: "min",
    value: (entry) => <Mono>{formatPerMillionUsd(cheapestOutputMicro(entry))}</Mono>
  },
  {
    id: "context",
    label: "Context",
    metric: (entry) => entry.model.context_window,
    best: "max",
    value: (entry) => <Mono>{formatTokenCount(entry.model.context_window)}</Mono>
  },
  {
    id: "max-output",
    label: "Max output",
    metric: (entry) => entry.model.max_output_tokens,
    best: "max",
    value: (entry) => <Mono>{formatTokenCount(entry.model.max_output_tokens)}</Mono>
  },
  {
    id: "throughput",
    label: "Throughput",
    metric: bestThroughput,
    best: "max",
    value: (entry) => <Mono>{formatThroughput(bestThroughput(entry))}</Mono>
  },
  {
    id: "uptime",
    label: "Uptime (30d)",
    metric: bestUptime,
    best: "max",
    value: (entry) => <Mono>{formatUptime(bestUptime(entry))}</Mono>
  },
  {
    id: "modalities",
    label: "Modalities",
    value: (entry) => <ModalityIcons modalities={entry.model.input_modalities} />
  },
  {
    id: "params",
    label: "Params",
    value: (entry) => <ParamChips params={supportedParamList(entry.model.supported_params)} />
  },
  {
    id: "released",
    label: "Released",
    value: (entry) => <Mono>{formatReleaseDate(entry.model.release_date)}</Mono>
  },
  {
    id: "providers",
    label: "Providers",
    value: (entry) => (
      <span className="inline-flex max-w-52 flex-wrap items-center gap-1">
        {pinExperientialCloudFirst(entry.providers).map((row) => (
          <ProviderBadge key={row.id} provider={row.provider} />
        ))}
        {entry.providers.length === 0 ? <span className="text-muted-2">—</span> : null}
      </span>
    )
  },
  {
    id: "category",
    label: "Category",
    value: (entry) => <span className="text-[12.5px]">{entry.model.category ?? "—"}</span>
  }
];

export function CompareBoard({ entries, selectedSlugs, initialExtras = {} }: CompareBoardProps) {
  const bySlug = useMemo(
    () => new Map(entries.map((entry) => [entry.model.slug, entry])),
    [entries]
  );

  // Benchmarks + links ride the DETAIL payload only (the catalog list stays
  // lean), so the server prefetches them for the deep-linked selection and a
  // model toggled in afterwards loads its own through the public detail route.
  // Best-effort: a failed load leaves that column's benchmark cells empty
  // rather than breaking the board. Each slug is attempted once per mount.
  const [extrasBySlug, setExtrasBySlug] = useState<Record<string, ModelBenchmarkExtras>>(
    initialExtras
  );
  const attemptedSlugs = useRef(new Set(Object.keys(initialExtras)));

  // The selection lives in client state so checking a row reflects instantly
  // (optimistic) and the matrix recomputes from data already shipped with the
  // page — no router.replace, which under force-dynamic re-ran the whole server
  // render and refetched the catalog on every click, so the checkbox lagged and
  // the comparison never felt live (the product owner). The URL still mirrors the selection
  // for shareable deep links, written with history.replaceState so it updates
  // in place without a navigation or refetch.
  const [currentSlugs, setCurrentSlugs] = useState<string[]>(() =>
    dedupeKnown(selectedSlugs, bySlug)
  );

  // A real navigation (a fresh deep link, or Back/Forward) hands down new
  // selectedSlugs; adopt it. Ordinary in-page toggles set currentSlugs first
  // and only mirror to the URL after, so this no-ops for them.
  useEffect(() => {
    const next = dedupeKnown(selectedSlugs, bySlug);
    setCurrentSlugs((prev) => (sameSlugs(prev, next) ? prev : next));
  }, [selectedSlugs, bySlug]);

  const apply = useCallback((slugs: string[]) => {
    setCurrentSlugs(slugs);
    if (typeof window !== "undefined") {
      const url =
        slugs.length === 0
          ? "/models/compare"
          : `/models/compare?models=${slugs.map(encodeURIComponent).join(",")}`;
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);

  useEffect(() => {
    for (const slug of currentSlugs) {
      if (attemptedSlugs.current.has(slug)) {
        continue;
      }
      attemptedSlugs.current.add(slug);
      void (async () => {
        try {
          const response = await fetch(`/api/models/${encodeURIComponent(slug)}`);
          if (!response.ok) {
            return;
          }
          const detail = (await response.json()) as ModelDetail;
          setExtrasBySlug((prev) => ({
            ...prev,
            [slug]: {
              benchmarks: detail.benchmarks ?? [],
              huggingface_url: detail.huggingface_url ?? null,
              release_url: detail.release_url ?? null
            }
          }));
        } catch {
          // Benchmarks are additive; the comparison stands without them.
        }
      })();
    }
  }, [currentSlugs]);

  const selected = currentSlugs
    .map((slug) => bySlug.get(slug))
    .filter((entry): entry is CatalogEntry => entry !== undefined);

  // Checking a row adds it (up to the limit); unchecking removes it. Instant:
  // both paths update client state, then mirror the URL.
  const toggle = (slug: string) => {
    if (currentSlugs.includes(slug)) {
      apply(currentSlugs.filter((current) => current !== slug));
      return;
    }
    if (currentSlugs.length >= COMPARE_LIMIT) {
      return;
    }
    apply([...currentSlugs, slug]);
  };

  return (
    <div className="flex min-h-0 grow flex-col gap-4">
      {selected.length >= 2 ? (
        <>
          <div className="flex shrink-0 items-center justify-end">
            {/* Same door as every playground deep link (gamepad mark), in the
                quiet white/gray button so the matrix stays the page's focus. */}
            <Link
              className={buttonClassName("default", undefined, "sm")}
              data-testid="open-in-playground"
              href={playgroundComparePath(selected.map((entry) => entry.model.slug))}
            >
              <Gamepad2 aria-hidden size={14} strokeWidth={1.8} />
              Open in playground
            </Link>
          </div>
          <CompareMatrix
            entries={selected}
            extrasBySlug={extrasBySlug}
            onRemove={(slug) => apply(currentSlugs.filter((current) => current !== slug))}
          />
        </>
      ) : (
        <p className="m-0 shrink-0 text-[13px] leading-relaxed text-muted" data-testid="compare-hint">
          {selected.length === 0
            ? "Select at least two models below to compare their prices, context, capabilities, and providers side by side. Filter and sort exactly as you do on the catalog."
            : `Selected ${selected[0].model.display_name}. Pick one more below to compare.`}
        </p>
      )}

      <CatalogTable entries={entries} selection={{ onToggle: toggle, selected: currentSlugs }} />
    </div>
  );
}

/** URL slugs, de-duplicated, capped, and limited to models we actually have. */
function dedupeKnown(
  slugs: string[],
  bySlug: Map<string, CatalogEntry>
): string[] {
  return [...new Set(slugs)].filter((slug) => bySlug.has(slug)).slice(0, COMPARE_LIMIT);
}

/** Same slugs in the same order. */
function sameSlugs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((slug, index) => slug === b[index]);
}

/** The chosen models side by side: columns are models, rows are catalog facts. */
function CompareMatrix({
  entries,
  extrasBySlug,
  onRemove
}: {
  entries: CatalogEntry[];
  extrasBySlug: Record<string, ModelBenchmarkExtras>;
  onRemove: (slug: string) => void;
}) {
  const slugs = entries.map((entry) => entry.model.slug);
  const benchmarkRows = mergeBenchmarkRows(slugs, extrasBySlug);
  const bestBy = (row: CompareRow): Set<string> => {
    if (!row.metric || !row.best || entries.length < 2) {
      return new Set();
    }
    const values = entries
      .map((entry) => ({ slug: entry.model.slug, value: row.metric?.(entry) ?? null }))
      .filter((item): item is { slug: string; value: number } => item.value !== null);
    if (values.length < 2) {
      return new Set();
    }
    const target =
      row.best === "min"
        ? Math.min(...values.map((item) => item.value))
        : Math.max(...values.map((item) => item.value));
    return new Set(values.filter((item) => item.value === target).map((item) => item.slug));
  };

  return (
    <div
      // Cap the comparison's height so the picker below stays on screen: with a
      // full row set the matrix used to push the catalog table off the bottom
      // and you couldn't see what you were selecting (the product owner). It scrolls within
      // this bound instead.
      className="max-h-[45vh] shrink-0 overflow-auto rounded-lg border border-line bg-surface"
      data-testid="compare-matrix"
    >
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line">
            <th className="w-36 px-4 py-3 text-left align-bottom" scope="col">
              <span className="mono-label">Compare</span>
            </th>
            {entries.map((entry) => (
              <th className="min-w-44 px-4 py-3 text-left" key={entry.model.slug} scope="col">
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <Link
                      className="flex items-center gap-2 truncate text-[14px] font-semibold text-foreground hover:underline"
                      href={modelPath(entry.model.slug)}
                    >
                      <ModelIcon
                        icon={modelIconKey(entry.model)}
                        name={entry.model.display_name}
                        size={16}
                      />
                      {entry.model.display_name}
                    </Link>
                    <span className="block truncate font-mono text-[10.5px] font-normal text-muted-2">
                      {entry.model.slug}
                    </span>
                    <ModelExternalLink extras={extrasBySlug[entry.model.slug]} />
                  </span>
                  <button
                    aria-label={`Remove ${entry.model.display_name}`}
                    className="shrink-0 cursor-pointer rounded-sm p-1 text-muted transition-colors hover:bg-surface-subtle hover:text-ink"
                    onClick={() => onRemove(entry.model.slug)}
                    type="button"
                  >
                    <X size={13} strokeWidth={1.8} />
                  </button>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => {
            const best = bestBy(row);
            return (
              <tr className="border-b border-line last:border-b-0" key={row.id}>
                <th className="px-4 py-2.5 text-left align-middle" scope="row">
                  <span className="mono-label">{row.label}</span>
                </th>
                {entries.map((entry) => (
                  <td
                    className={clsx(
                      "px-4 py-2.5 align-middle",
                      best.has(entry.model.slug) && "bg-accent-soft/50"
                    )}
                    data-best={best.has(entry.model.slug) ? "true" : undefined}
                    key={entry.model.slug}
                  >
                    {row.value(entry)}
                  </td>
                ))}
              </tr>
            );
          })}
          {benchmarkRows.length > 0 ? (
            <tr className="border-b border-line bg-surface-subtle/50">
              <th className="px-4 py-2 text-left" colSpan={entries.length + 1} scope="colgroup">
                <span className="mono-label">Benchmarks</span>
              </th>
            </tr>
          ) : null}
          {benchmarkRows.map((row) => {
            const best = bestBenchmarkSlugs(row, slugs);
            return (
              <tr
                className="border-b border-line last:border-b-0"
                data-testid="compare-benchmark-row"
                key={row.benchmark}
              >
                <th className="px-4 py-2.5 text-left align-middle" scope="row">
                  <span className="mono-label">{row.display_name}</span>
                </th>
                {entries.map((entry) => {
                  const score = row.scoreBySlug[entry.model.slug];
                  return (
                    <td
                      className={clsx(
                        "px-4 py-2.5 align-middle",
                        best.has(entry.model.slug) && "bg-accent-soft/50"
                      )}
                      data-best={best.has(entry.model.slug) ? "true" : undefined}
                      key={entry.model.slug}
                    >
                      {score === undefined ? (
                        <span className="text-muted-2">—</span>
                      ) : (
                        <Mono>
                          <span
                            title={`${benchmarkSourceLabel(score.source)} · ${formatRetrievedAt(
                              score.retrieved_at
                            )}`}
                          >
                            {formatBenchmarkScore(score)}
                          </span>
                        </Mono>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Compact Hugging Face / release link under a compare column's slug. */
function ModelExternalLink({ extras }: { extras: ModelBenchmarkExtras | undefined }) {
  const href = extras?.huggingface_url ?? extras?.release_url ?? null;
  if (href === null) {
    return null;
  }
  return (
    <a
      className="block w-fit truncate text-[10.5px] font-normal text-muted-2 transition-colors hover:text-ink"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {extras?.huggingface_url !== null && extras?.huggingface_url !== undefined
        ? "Hugging Face"
        : "Release notes"}
    </a>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[12.5px] text-ink-soft">{children}</span>;
}
