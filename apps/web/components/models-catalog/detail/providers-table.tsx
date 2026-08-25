"use client";

// The model detail page's per-provider comparison table (OpenRouter's model-page
// provider table is the reference): every route to this model with its serving
// stats — tok/s, latency, uptime — plus context/max output, prices, and
// quantization, every column click-sortable. The DEFAULT order pins
// experiential_cloud first, then other host-managed lanes, then throughput;
// a header click re-sorts the whole table.
// Stats follow the estimate→measured strategy: seeded values are marked
// estimated (cell tooltips name the source) and flip to measured once the
// observed overlay has enough serving volume for the route.

import { useMemo } from "react";

import { ProviderBadge, StatusDot } from "@/components/models-catalog/badges";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import {
  formatLatency,
  formatThroughput,
  formatTokenCount,
  formatUptime,
  hasCacheDiscount
} from "@/lib/models-catalog/format";
import { isEstimatedPricing, isMeasuredStats, statsSourceLabel } from "@/lib/models-catalog/provenance";
import { isHostServed, pinExperientialCloudFirst } from "@/lib/models-catalog/serving";
import { formatPerMillionUsd } from "@/lib/money";
import type { CatalogDeployment, CatalogModel } from "@/lib/models-catalog/types";

/** Quantization parsed from the provider's wire id; null when unpublished. */
export function quantizationOf(deployment: CatalogDeployment): string | null {
  const match = deployment.provider_model_id
    .toLowerCase()
    .match(/(?:^|-)(nvfp4|fp8|fp4|bf16|fp16|int8|int4|awq|gptq)(?:$|[-:])/);
  return match?.[1] ?? null;
}

/**
 * Provider-column sort key: experiential_cloud identity first, then other
 * host-served lanes, then provider name. Throughput does not win.
 */
export function providerColumnSortKey(row: CatalogDeployment): string {
  return `${row.provider === "experiential_cloud" ? "0" : "1"}-${isHostServed(row) ? "0" : "1"}-${row.provider}`;
}

/**
 * Default row order: experiential_cloud first (identity, even when slower),
 * then other Experiential-hosted lanes, then highest throughput, then
 * provider name. Header clicks re-sort the whole table after this.
 */
export function defaultProviderOrder(providers: CatalogDeployment[]): CatalogDeployment[] {
  const pinned = pinExperientialCloudFirst(providers);
  const cloud = pinned.filter((row) => row.provider === "experiential_cloud");
  const rest = pinned.filter((row) => row.provider !== "experiential_cloud");
  const orderedRest = [...rest].sort((a, b) => {
    const hosted = Number(isHostServed(b)) - Number(isHostServed(a));
    if (hosted !== 0) {
      return hosted;
    }
    const tps = (b.throughput_tps ?? -1) - (a.throughput_tps ?? -1);
    if (tps !== 0) {
      return tps;
    }
    return a.provider.localeCompare(b.provider);
  });
  return [...cloud, ...orderedRest];
}

type ProvidersTableProps = {
  providers: CatalogDeployment[];
  /** Context window / max output live on the model row (shared by every lane). */
  model: CatalogModel;
};

export function ProvidersTable({ providers, model }: ProvidersTableProps) {
  const rows = useMemo(() => defaultProviderOrder(providers), [providers]);
  const columns = useMemo<Array<DataTableColumn<CatalogDeployment>>>(
    () => [
      {
        id: "provider",
        header: "Provider",
        sortValue: providerColumnSortKey,
        cell: (row) => (
          <span className="inline-flex items-center gap-2">
            <ProviderBadge provider={row.provider} />
            {isHostServed(row) ? (
              <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-accent">
                experiential
              </span>
            ) : null}
            {row.owning_org_id !== null ? (
              <span className="font-mono text-[10px] uppercase tracking-wide text-purple">
                yours
              </span>
            ) : null}
          </span>
        )
      },
      {
        id: "throughput",
        header: "Tok/s",
        align: "right",
        defaultDirection: "desc",
        sortValue: (row) => row.throughput_tps,
        cell: (row) => (
          <Stat deployment={row}>{formatThroughput(row.throughput_tps)}</Stat>
        )
      },
      {
        id: "latency",
        header: "Latency",
        align: "right",
        defaultDirection: "asc",
        sortValue: (row) => row.latency_p50_ms,
        cell: (row) => <Stat deployment={row}>{formatLatency(row.latency_p50_ms)}</Stat>
      },
      {
        id: "uptime",
        header: "Uptime",
        align: "right",
        defaultDirection: "desc",
        sortValue: (row) => row.uptime_30d,
        cell: (row) => <Stat deployment={row}>{formatUptime(row.uptime_30d)}</Stat>
      },
      {
        id: "context",
        header: "Context",
        align: "right",
        defaultDirection: "desc",
        className: "hidden md:table-cell",
        sortValue: () => model.context_window,
        cell: () => <Num>{formatTokenCount(model.context_window)}</Num>
      },
      {
        id: "max-output",
        header: "Max out",
        align: "right",
        defaultDirection: "desc",
        className: "hidden lg:table-cell",
        sortValue: () => model.max_output_tokens,
        cell: () => <Num>{formatTokenCount(model.max_output_tokens)}</Num>
      },
      {
        id: "input",
        header: "Input $/M",
        align: "right",
        defaultDirection: "asc",
        sortValue: (row) => row.input_micro_usd_per_million,
        cell: (row) => (
          <Price deployment={row}>
            {formatPerMillionUsd(row.input_micro_usd_per_million)}
          </Price>
        )
      },
      {
        id: "output",
        header: "Output $/M",
        align: "right",
        defaultDirection: "asc",
        sortValue: (row) => row.output_micro_usd_per_million,
        cell: (row) => (
          <Price deployment={row}>
            {formatPerMillionUsd(row.output_micro_usd_per_million)}
          </Price>
        )
      },
      {
        id: "cached",
        header: "Cached $/M",
        align: "right",
        defaultDirection: "asc",
        className: "hidden xl:table-cell",
        sortValue: (row) => row.cached_input_micro_usd_per_million,
        cell: (row) => (
          <span className="inline-flex items-center gap-1.5">
            {hasCacheDiscount(row) ? (
              <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-accent">
                cache
              </span>
            ) : null}
            <Price deployment={row}>
              {formatPerMillionUsd(row.cached_input_micro_usd_per_million)}
            </Price>
          </span>
        )
      },
      {
        id: "quant",
        header: "Quant",
        align: "right",
        className: "hidden lg:table-cell",
        sortValue: (row) => quantizationOf(row),
        cell: (row) => <Num>{quantizationOf(row) ?? "—"}</Num>
      },
      {
        id: "status",
        header: "Status",
        cell: (row) => <StatusDot status={row.status} />
      },
      {
        id: "source",
        header: "Stats",
        className: "hidden md:table-cell",
        sortValue: (row) => (isMeasuredStats(row) ? 0 : 1),
        cell: (row) => (
          <span
            className="font-mono text-[10.5px] text-muted-2"
            title={statsSourceLabel(row) ?? undefined}
          >
            {row.stats_source === null ? "—" : isMeasuredStats(row) ? "measured" : "estimated"}
          </span>
        )
      }
    ],
    [model.context_window, model.max_output_tokens]
  );
  return (
    <DataTable
      aria-label="Provider comparison for this model"
      columns={columns}
      rowKey={(row) => row.id}
      rows={rows}
    />
  );
}

function Num({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[12px] text-ink-soft">{children}</span>;
}

/** A stat cell whose tooltip names the source (measured vs estimated). */
function Stat({
  deployment,
  children
}: {
  deployment: CatalogDeployment;
  children: React.ReactNode;
}) {
  return (
    <span
      className="font-mono text-[12px] text-ink-soft"
      title={statsSourceLabel(deployment) ?? undefined}
    >
      {children}
    </span>
  );
}

/** A price cell that carries the estimate marker when the price is a guess. */
function Price({
  deployment,
  children
}: {
  deployment: CatalogDeployment;
  children: React.ReactNode;
}) {
  const estimated = isEstimatedPricing(deployment);
  return (
    <span
      className="font-mono text-[12px] text-ink-soft"
      title={estimated ? "Estimated price, not yet verified for this provider" : undefined}
    >
      {children}
      {estimated ? <span className="ml-0.5 text-muted-2">≈</span> : null}
    </span>
  );
}
