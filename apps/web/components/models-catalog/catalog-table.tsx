"use client";

// The /models storefront: dense table-first catalog over the whole gateway
// model list. One fetch ships every visible row to the client (the catalog is
// a few hundred rows at most), so search, filters, sorts, the per-route view,
// and compare selection are all instant pure recomputes — no spinners between
// interactions. Preferred models stay pinned in their own band under every
// sort; the band order is the API's (preferred_rank, then slug).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Columns2, Plus, Search, Sparkles, X } from "lucide-react";
import { clsx } from "clsx";

import { ModalityIcons, ParamChips, PercentOffChip, PromoChipBadge, ProviderBadge, StatusDot } from "./badges";
import { ModelIcon } from "./model-icon";
import { RecommendedStar } from "./recommended-star";
import {
  catalogCategories,
  catalogProviders,
  COMPARE_LIMIT,
  countActiveFilters,
  EMPTY_FILTERS,
  filterEntries,
  filterRoutes,
  throughputSortValue,
  type CatalogFilterState,
  type CatalogView,
  type RouteRow
} from "./filtering";
import { modelFamily, modelFamilyKey, modelIconKey } from "@/lib/models-catalog/families";
import { promoChipsBySlug } from "@/lib/models-catalog/promotions";
import { rankByFrontier } from "@/lib/models-catalog/ranking";
import { FilterMenu } from "./filter-menu";
import { Button, buttonClassName } from "@/components/ui/Button";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { SlidingTabs } from "@/components/ui/SlidingTabs";
import {
  bestUptime,
  cheapestInputMicro,
  cheapestOutputMicro,
  formatLatency,
  formatReleaseDate,
  formatThroughput,
  formatTokenCount,
  formatUptime,
  hasCacheDiscount,
  providerLabel,
  supportedParamList
} from "@/lib/models-catalog/format";
import { formatPerMillionUsd } from "@/lib/money";
import { pinExperientialCloudFirst, requiresOwnKey } from "@/lib/models-catalog/serving";
import { modelPath } from "@/lib/routes";
import type { CatalogEntry, ModelPromotion } from "@/lib/models-catalog/types";

// The recommended models collapse into one always-open band near the top
// (under Promotional); every other model folds into a collapsed per-family
// section below it (the product owner, r2: show the recommended set prominently, keep the
// rest one click away rather than deleting them).
const RECOMMENDED_GROUP = "__recommended__";

// The promotional models band: a table section ABOVE Recommended holding every
// model covered by an active promotion. A promoted model renders there AND in
// its normal family section (additive overlay), so the model view's rows carry
// their band explicitly instead of deriving it from the entry alone.
const PROMOTIONAL_GROUP = "__promotional__";

/** One model-view row: the catalog entry plus the band it renders in. */
type CatalogRow = {
  entry: CatalogEntry;
  group: string;
};

const MODALITY_OPTIONS = ["text", "image", "audio", "video", "pdf"];
const PARAM_OPTIONS = ["tools", "reasoning", "temperature", "structured_outputs", "logprobs"];
const CONTEXT_OPTIONS = [
  { value: "131072", label: "≥ 128K tokens" },
  { value: "262144", label: "≥ 256K tokens" },
  { value: "1000000", label: "≥ 1M tokens" }
];
const PRICE_OPTIONS = [
  { value: "100000", label: "≤ $0.10 / M input" },
  { value: "500000", label: "≤ $0.50 / M input" },
  { value: "1000000", label: "≤ $1 / M input" },
  { value: "2000000", label: "≤ $2 / M input" },
  { value: "5000000", label: "≤ $5 / M input" }
];
const AGE_OPTIONS = [
  { value: "30", label: "≤ 30 days old" },
  { value: "90", label: "≤ 90 days old" },
  { value: "365", label: "≤ 1 year old" }
];

type CatalogTableProps = {
  entries: CatalogEntry[];
  /**
   * The active promotional set (ordered by display_order), from
   * public.model_promotions with scopes resolved server-side. Rendered as a
   * Promotional table section above Recommended; the same models ALSO stay in
   * their normal family/recommended sections below.
   */
  promotions?: ModelPromotion[];
  /**
   * Controlled compare selection. When present, the row checkboxes read and
   * write it (the compare page drives selection through the URL) and the
   * navigate-to-compare bar is suppressed, since that page shows the comparison
   * inline. Omitted on the storefront, where the table owns selection and the
   * sticky bar links to /compare.
   */
  selection?: {
    selected: string[];
    onToggle: (slug: string) => void;
  };
  /**
   * Storefront only: the server renders the shared cached PUBLIC catalog for an
   * instant, flash-free paint, and the signed-in viewer's own custom models are
   * hydrated here after mount (GET /api/models?owner=org) and merged in — so the
   * private overlay never blocks the first render. Off (compare board) when the
   * caller already handed us the merged set server-side.
   */
  hydrateOrgModels?: boolean;
};

export function CatalogTable({
  entries: baseEntries,
  promotions = [],
  selection,
  hydrateOrgModels = false
}: CatalogTableProps) {
  const router = useRouter();
  const [view, setView] = useState<CatalogView>("models");
  const [filters, setFilters] = useState<CatalogFilterState>(EMPTY_FILTERS);
  const [internalSelected, setInternalSelected] = useState<string[]>([]);
  const compareSlugs = selection?.selected ?? internalSelected;

  // The signed-in org overlay, fetched after paint and merged over the public
  // base. A signed-out viewer (or a viewer with no custom models) gets an empty
  // list and the base catalog stands; any read failure leaves the base intact.
  const [orgEntries, setOrgEntries] = useState<CatalogEntry[]>([]);
  useEffect(() => {
    if (!hydrateOrgModels) {
      return;
    }
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/models?owner=org", { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { models?: CatalogEntry[] };
        if (active && payload.models && payload.models.length > 0) {
          setOrgEntries(payload.models);
        }
      } catch {
        // The public base catalog stands on its own; no error surface needed.
      }
    })();
    return () => {
      active = false;
    };
  }, [hydrateOrgModels]);

  // Merge the org overlay over the public base, keyed by SLUG so an org model
  // SHADOWS the public model of the same slug (that is how the backend resolves
  // a collision — the org's own row wins) rather than rendering two conflicting
  // rows for one slug. A shadowing org model keeps the public row's position;
  // net-new org models append. Client-side ranking below re-sorts the merged
  // set, so order here is not load-bearing.
  const entries = useMemo(() => {
    if (orgEntries.length === 0) {
      return baseEntries;
    }
    const bySlug = new Map(baseEntries.map((entry) => [entry.model.slug, entry]));
    for (const entry of orgEntries) {
      bySlug.set(entry.model.slug, entry);
    }
    return [...bySlug.values()];
  }, [baseEntries, orgEntries]);

  const patch = (partial: Partial<CatalogFilterState>) =>
    setFilters((current) => ({ ...current, ...partial }));

  // Frontier-ranked default order (preferred first, then the size/price/recency
  // blend). Grouping by family below keeps this order per band, so the family
  // with the strongest model leads — the family-boosted default the product owner asked for.
  const modelRows = useMemo(
    () => rankByFrontier(filterEntries(entries, filters)),
    [entries, filters]
  );
  const routeRows = useMemo(() => filterRoutes(entries, filters), [entries, filters]);
  // One representative entry per family, so the group header can paint its logo.
  const familyHeaders = useMemo(() => {
    const map = new Map<string, CatalogEntry>();
    for (const entry of modelRows) {
      const key = modelFamilyKey(entry);
      if (!map.has(key)) {
        map.set(key, entry);
      }
    }
    return map;
  }, [modelRows]);
  // Promo overlays from the resolved server-side promotion views: each slug's
  // single RANKED chip (free outranks percent — promotions.ts owns the rule),
  // memoized as an O(1) lookup for the render hot path, plus the percent promos
  // whose chips land on family headers.
  const promoChips = useMemo(() => promoChipsBySlug(promotions), [promotions]);
  const percentPromos = useMemo(
    () => promotions.filter((promo) => promo.percent_off > 0),
    [promotions]
  );
  // The Promotional section: the union of every promo's resolved slugs (promos
  // in display_order; a slug's first promo wins its position), resolved against
  // the FILTERED rows so search/filters apply inside the section like anywhere
  // else. These same entries also render in their normal sections below (a
  // promo model appears in BOTH places) — an additive overlay, not a move.
  const promoEntries = useMemo(() => {
    const bySlug = new Map(modelRows.map((entry) => [entry.model.slug, entry]));
    const seen = new Set<string>();
    const resolved: CatalogEntry[] = [];
    for (const promo of [...promotions].sort((a, b) => a.display_order - b.display_order)) {
      for (const slug of promo.slugs) {
        if (seen.has(slug)) {
          continue;
        }
        seen.add(slug);
        const entry = bySlug.get(slug);
        if (entry !== undefined) {
          resolved.push(entry);
        }
      }
    }
    return resolved;
  }, [modelRows, promotions]);
  // Families carrying an active percent-off promo (their header wears the
  // chip) sort ahead of the other family sections — data-driven off the
  // promos' family_keys, never a hardcoded family name.
  const promoFamilyKeys = useMemo(
    () => new Set(percentPromos.flatMap((promo) => promo.family_keys)),
    [percentPromos]
  );
  // The model view's rows, each carrying its band: the Promotional section
  // first, then Recommended, then promo-chipped families, then the rest. The
  // partition is stable, so within each group the families keep rankByFrontier
  // order (DataTable bands follow each key's first occurrence).
  const tableRows = useMemo<CatalogRow[]>(() => {
    const recommended: CatalogRow[] = [];
    const promotedFamilies: CatalogRow[] = [];
    const otherFamilies: CatalogRow[] = [];
    for (const entry of modelRows) {
      if (entry.model.preferred_rank !== null) {
        recommended.push({ entry, group: RECOMMENDED_GROUP });
        continue;
      }
      const key = modelFamilyKey(entry);
      (promoFamilyKeys.has(key) ? promotedFamilies : otherFamilies).push({ entry, group: key });
    }
    return [
      ...promoEntries.map((entry) => ({ entry, group: PROMOTIONAL_GROUP })),
      ...recommended,
      ...promotedFamilies,
      ...otherFamilies
    ];
  }, [promoEntries, modelRows, promoFamilyKeys]);
  // The Promotional header carries the percent chip only when exactly ONE
  // percent promo covers rows in the section; with several, the per-row chips
  // disambiguate instead.
  const promoSectionPercents = useMemo(() => {
    const present = new Set(promoEntries.map((entry) => entry.model.slug));
    return percentPromos.filter((promo) => promo.slugs.some((slug) => present.has(slug)));
  }, [percentPromos, promoEntries]);
  const categories = useMemo(() => catalogCategories(entries), [entries]);
  const providers = useMemo(() => catalogProviders(entries), [entries]);
  const activeCount = countActiveFilters(filters);
  const routeCount = entries.reduce((sum, entry) => sum + entry.providers.length, 0);

  const toggleCompare = (slug: string) => {
    if (selection !== undefined) {
      selection.onToggle(slug);
      return;
    }
    setInternalSelected((current) => {
      if (current.includes(slug)) {
        return current.filter((entry) => entry !== slug);
      }
      return current.length >= COMPARE_LIMIT ? current : [...current, slug];
    });
  };

  const modelColumns = useMemo<Array<DataTableColumn<CatalogRow>>>(
    () => [
      {
        id: "compare",
        header: <span className="sr-only">Compare</span>,
        cell: ({ entry }) => (
          <input
            aria-label={`Compare ${entry.model.display_name}`}
            checked={compareSlugs.includes(entry.model.slug)}
            className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
            disabled={
              !compareSlugs.includes(entry.model.slug) && compareSlugs.length >= COMPARE_LIMIT
            }
            onChange={() => toggleCompare(entry.model.slug)}
            type="checkbox"
          />
        ),
        className: "w-8"
      },
      {
        id: "model",
        header: "Model",
        sortValue: ({ entry }) => entry.model.display_name.toLowerCase(),
        // One ranked chip per model (free outranks percent), worn in EVERY
        // section the model renders in — Promotional band and normal bands.
        cell: ({ entry }) => {
          const chip = promoChips.get(entry.model.slug);
          return (
            <span className="flex min-w-0 items-center gap-2">
              <ModelIcon icon={modelIconKey(entry.model)} name={entry.model.display_name} size={15} />
              <Link
                className="truncate font-semibold text-foreground hover:underline"
                href={modelPath(entry.model.slug)}
                onClick={(event) => event.stopPropagation()}
              >
                {entry.model.display_name}
              </Link>
              {entry.model.preferred_rank !== null ? <RecommendedStar size={13} /> : null}
              {chip !== undefined ? <PromoChipBadge chip={chip} /> : null}
              {requiresOwnKey(entry) ? (
                <span
                  className="shrink-0 rounded-full bg-warning-soft px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-warning"
                  title="Requires your own provider key — not hosted on Experiential credits"
                >
                  your key
                </span>
              ) : null}
              <span className="hidden truncate font-mono text-[11px] text-muted-2 xl:inline">
                {entry.model.slug}
              </span>
            </span>
          );
        }
      },
      {
        id: "providers",
        header: "Providers",
        cell: ({ entry }) => {
          const shown = pinExperientialCloudFirst(entry.providers).slice(0, 3);
          return (
            <span className="inline-flex items-center gap-1">
              {shown.map((row) => (
                <ProviderBadge key={row.id} provider={row.provider} />
              ))}
              {entry.providers.length > shown.length ? (
                <span className="font-mono text-[10px] text-muted-2">
                  +{entry.providers.length - shown.length}
                </span>
              ) : null}
              {entry.providers.length === 0 ? <span className="text-muted-2">—</span> : null}
            </span>
          );
        }
      },
      {
        id: "context",
        header: "Context",
        align: "right",
        defaultDirection: "desc",
        sortValue: ({ entry }) => entry.model.context_window,
        cell: ({ entry }) => <Num>{formatTokenCount(entry.model.context_window)}</Num>
      },
      {
        id: "input",
        header: "Input $/M",
        align: "right",
        defaultDirection: "asc",
        sortValue: ({ entry }) => cheapestInputMicro(entry),
        cell: ({ entry }) => (
          <span className="inline-flex items-center gap-1.5">
            {entry.providers.some(hasCacheDiscount) ? <CacheTag /> : null}
            <Num>{formatPerMillionUsd(cheapestInputMicro(entry))}</Num>
          </span>
        )
      },
      {
        id: "output",
        header: "Output $/M",
        align: "right",
        defaultDirection: "asc",
        sortValue: ({ entry }) => cheapestOutputMicro(entry),
        cell: ({ entry }) => <Num>{formatPerMillionUsd(cheapestOutputMicro(entry))}</Num>
      },
      {
        id: "modalities",
        header: "Modalities",
        className: "hidden md:table-cell",
        cell: ({ entry }) => <ModalityIcons modalities={entry.model.input_modalities} />
      },
      {
        id: "params",
        header: "Params",
        className: "hidden lg:table-cell",
        cell: ({ entry }) => (
          <ParamChips limit={3} params={supportedParamList(entry.model.supported_params)} />
        )
      },
      {
        id: "throughput",
        header: "Tok/s",
        align: "right",
        defaultDirection: "desc",
        className: "hidden md:table-cell",
        sortValue: ({ entry }) => throughputSortValue(entry),
        cell: ({ entry }) => <Num>{formatThroughput(throughputSortValue(entry))}</Num>
      },
      {
        id: "uptime",
        header: "Uptime",
        align: "right",
        defaultDirection: "desc",
        className: "hidden lg:table-cell",
        sortValue: ({ entry }) => bestUptime(entry),
        cell: ({ entry }) => <Num>{formatUptime(bestUptime(entry))}</Num>
      },
      {
        id: "released",
        header: "Released",
        align: "right",
        defaultDirection: "desc",
        className: "hidden xl:table-cell",
        sortValue: ({ entry }) => entry.model.release_date,
        cell: ({ entry }) => <Num>{formatReleaseDate(entry.model.release_date)}</Num>
      }
    ],
    [compareSlugs, promoChips]
  );

  const routeColumns = useMemo<Array<DataTableColumn<RouteRow>>>(
    () => [
      {
        id: "model",
        header: "Model",
        sortValue: (row) => row.entry.model.display_name.toLowerCase(),
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            <ModelIcon icon={modelIconKey(row.entry.model)} name={row.entry.model.display_name} size={15} />
            <Link
              className="truncate font-semibold text-foreground hover:underline"
              href={modelPath(row.entry.model.slug)}
              onClick={(event) => event.stopPropagation()}
            >
              {row.entry.model.display_name}
            </Link>
          </span>
        )
      },
      {
        id: "provider",
        header: "Provider",
        sortValue: (row) => providerLabel(row.deployment.provider),
        cell: (row) => <ProviderBadge provider={row.deployment.provider} />
      },
      {
        id: "wire-id",
        header: "Provider model id",
        className: "hidden md:table-cell",
        cell: (row) => (
          // Content-sized, never clamped: the table is auto-layout (min-w-max +
          // scroll container), so this column WIDENS to fit whatever section is
          // open — a fixed max-w here ellipsized long Fireworks/Bedrock wire ids
          // and kept the column frozen when a section with longer ids expanded
          // (the product owner r3: columns must resize per open section).
          <span className="block font-mono text-[11.5px] text-ink-soft">
            {row.deployment.provider_model_id}
          </span>
        )
      },
      {
        id: "context",
        header: "Context",
        align: "right",
        defaultDirection: "desc",
        sortValue: (row) => row.entry.model.context_window,
        cell: (row) => <Num>{formatTokenCount(row.entry.model.context_window)}</Num>
      },
      {
        id: "input",
        header: "Input $/M",
        align: "right",
        defaultDirection: "asc",
        sortValue: (row) => row.deployment.input_micro_usd_per_million,
        cell: (row) => (
          <span className="inline-flex items-center gap-1.5">
            {hasCacheDiscount(row.deployment) ? <CacheTag /> : null}
            <Num>{formatPerMillionUsd(row.deployment.input_micro_usd_per_million)}</Num>
          </span>
        )
      },
      {
        id: "output",
        header: "Output $/M",
        align: "right",
        defaultDirection: "asc",
        sortValue: (row) => row.deployment.output_micro_usd_per_million,
        cell: (row) => <Num>{formatPerMillionUsd(row.deployment.output_micro_usd_per_million)}</Num>
      },
      {
        id: "throughput",
        header: "Tok/s",
        align: "right",
        defaultDirection: "desc",
        className: "hidden md:table-cell",
        sortValue: (row) => row.deployment.throughput_tps,
        cell: (row) => <Num>{formatThroughput(row.deployment.throughput_tps)}</Num>
      },
      {
        id: "uptime",
        header: "Uptime",
        align: "right",
        defaultDirection: "desc",
        className: "hidden lg:table-cell",
        sortValue: (row) => row.deployment.uptime_30d,
        cell: (row) => <Num>{formatUptime(row.deployment.uptime_30d)}</Num>
      },
      {
        id: "latency",
        header: "Latency",
        align: "right",
        defaultDirection: "asc",
        className: "hidden lg:table-cell",
        sortValue: (row) => row.deployment.latency_p50_ms,
        cell: (row) => <Num>{formatLatency(row.deployment.latency_p50_ms)}</Num>
      },
      {
        id: "status",
        header: "Status",
        className: "hidden md:table-cell",
        cell: (row) => <StatusDot status={row.deployment.status} />
      }
    ],
    []
  );

  return (
    <div className="flex min-h-0 grow flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <label className="relative min-w-44 grow sm:max-w-72">
          <Search
            aria-hidden
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2"
            size={13}
            strokeWidth={1.8}
          />
          <input
            aria-label="Search models"
            className="min-h-[30px] w-full rounded-md border border-line-strong bg-surface pl-8 pr-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:border-accent focus:outline-none"
            onChange={(event) => patch({ query: event.target.value })}
            placeholder="Search models, providers…"
            type="search"
            value={filters.query}
          />
        </label>
        <SlidingTabs
          activeKey={view}
          ariaLabel="Catalog view"
          onPick={(key) => setView(key as CatalogView)}
          tabs={[
            { key: "models", label: "Models" },
            { key: "routes", label: "Provider routes" }
          ]}
        />
        {/* Neutral pair (the product owner, 2026-08-24): Compare then Add model, both the
            default white/gray variant so neither reads as the page's CTA.
            Compare is suppressed under controlled selection like the sticky
            bar: on the compare page itself the bare link would clear the
            active ?models= selection. */}
        {selection === undefined ? (
          <Link className={buttonClassName("default", "ml-auto", "sm")} href="/models/compare">
            <Columns2 aria-hidden size={14} strokeWidth={1.8} />
            Compare
          </Link>
        ) : null}
        <Link
          className={buttonClassName("default", selection === undefined ? undefined : "ml-auto", "sm")}
          href="/models/new"
        >
          <Plus aria-hidden size={14} strokeWidth={1.8} />
          Add model
        </Link>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <FilterMenu
          label="Provider"
          multi
          onChange={(selected) => patch({ providers: selected })}
          options={providers.map((value) => ({ value, label: providerLabel(value) }))}
          selected={filters.providers}
        />
        <FilterMenu
          label="Modality"
          multi
          onChange={(selected) => patch({ modalities: selected })}
          options={MODALITY_OPTIONS.map((value) => ({ value, label: value }))}
          selected={filters.modalities}
        />
        <FilterMenu
          label="Params"
          multi
          onChange={(selected) => patch({ params: selected })}
          options={PARAM_OPTIONS.map((value) => ({ value, label: value.replaceAll("_", " ") }))}
          selected={filters.params}
        />
        {categories.length > 0 ? (
          <FilterMenu
            label="Category"
            onChange={(selected) => patch({ category: selected[0] ?? null })}
            options={categories.map((value) => ({ value, label: value }))}
            selected={filters.category === null ? [] : [filters.category]}
          />
        ) : null}
        <FilterMenu
          label="Context"
          onChange={(selected) =>
            patch({ minContext: selected[0] === undefined ? null : Number(selected[0]) })
          }
          options={CONTEXT_OPTIONS}
          selected={filters.minContext === null ? [] : [String(filters.minContext)]}
        />
        <FilterMenu
          label="Price"
          onChange={(selected) =>
            patch({ maxInputMicro: selected[0] === undefined ? null : Number(selected[0]) })
          }
          options={PRICE_OPTIONS}
          selected={filters.maxInputMicro === null ? [] : [String(filters.maxInputMicro)]}
        />
        <FilterMenu
          label="Age"
          onChange={(selected) =>
            patch({ maxAgeDays: selected[0] === undefined ? null : Number(selected[0]) })
          }
          options={AGE_OPTIONS}
          selected={filters.maxAgeDays === null ? [] : [String(filters.maxAgeDays)]}
        />
        <button
          aria-pressed={filters.discountsOnly}
          className={clsx(
            "inline-flex min-h-[30px] cursor-pointer items-center rounded-md border px-2.5 text-[12.5px] font-semibold transition-colors",
            filters.discountsOnly
              ? "border-accent/40 bg-accent-soft text-accent"
              : "border-line-strong bg-surface text-ink-soft hover:text-ink"
          )}
          onClick={() => patch({ discountsOnly: !filters.discountsOnly })}
          type="button"
        >
          Cache discount
        </button>
        {activeCount > 0 ? (
          <button
            className="inline-flex min-h-[30px] cursor-pointer items-center gap-1 rounded-md px-2 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
            onClick={() => setFilters(EMPTY_FILTERS)}
            type="button"
          >
            <X aria-hidden size={12} strokeWidth={1.8} />
            Clear
          </button>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {view === "models"
            ? `${modelRows.length} of ${entries.length} models`
            : `${routeRows.length} of ${routeCount} routes`}
        </span>
      </div>

      {view === "models" ? (
        <DataTable
          aria-label="Model catalog"
          columns={modelColumns}
          emptyState={
            <EmptyState
              body="No model matches these filters. Clear one or add your own model."
              title="Nothing matches"
            />
          }
          collapsibleGroups
          groupKey={(row) => row.group}
          initialCollapsedGroup={(key) =>
            key !== RECOMMENDED_GROUP && key !== PROMOTIONAL_GROUP
          }
          renderGroupHeader={(key, count) => {
            if (key === PROMOTIONAL_GROUP) {
              return (
                <span className="flex items-center gap-2 text-ink" data-testid="promotional-section">
                  <Sparkles aria-hidden className="text-accent" size={13} strokeWidth={1.8} />
                  <span className="mono-label text-accent">Promotional</span>
                  <span className="font-mono text-[11px] text-ink-faint">{count}</span>
                  {promoSectionPercents.length === 1 ? (
                    <PercentOffChip
                      percent={promoSectionPercents[0].percent_off}
                      providers={promoSectionPercents[0].providers}
                    />
                  ) : null}
                </span>
              );
            }
            if (key === RECOMMENDED_GROUP) {
              return (
                <span className="flex items-center gap-2 text-ink">
                  <RecommendedStar size={13} />
                  <span className="mono-label">Recommended</span>
                  <span className="font-mono text-[11px] text-ink-faint">{count}</span>
                </span>
              );
            }
            const entry = familyHeaders.get(key);
            const label = entry ? modelFamily(entry).label : key;
            // One quiet chip per header: with several promos on a family, the
            // lowest display_order wins the slot.
            const familyPromo = percentPromos
              .filter((promo) => promo.family_keys.includes(key))
              .sort((a, b) => a.display_order - b.display_order)[0];
            return (
              <span className="flex items-center gap-2 text-ink">
                {entry ? <ModelIcon icon={modelIconKey(entry.model)} name={label} size={14} /> : null}
                <span className="mono-label">{label}</span>
                <span className="font-mono text-[11px] text-ink-faint">{count}</span>
                {familyPromo !== undefined ? (
                  <PercentOffChip
                    percent={familyPromo.percent_off}
                    providers={familyPromo.providers}
                  />
                ) : null}
              </span>
            );
          }}
          rowHref={(row) => modelPath(row.entry.model.slug)}
          rowKey={(row) => `${row.group}:${row.entry.model.id}`}
          rows={tableRows}
        />
      ) : (
        <DataTable
          aria-label="Provider routes"
          columns={routeColumns}
          emptyState={
            <EmptyState
              body="No provider route matches these filters."
              title="Nothing matches"
            />
          }
          rowHref={(row) => modelPath(row.entry.model.slug)}
          rowKey={(row) => row.deployment.id}
          rows={routeRows}
        />
      )}

      <p className="m-0 shrink-0 font-mono text-[11px] text-ink-faint">
        Prices are per million tokens; the cheapest route is shown in the model view. Uptime,
        throughput, and latency come from each route&apos;s labeled stats source. Unknown figures
        show a dash, never $0.
      </p>

      {selection === undefined && compareSlugs.length > 0 ? (
        <div className="sticky bottom-3 z-10 flex items-center gap-3 self-center rounded-lg border border-line bg-surface px-4 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.08)]">
          <span className="text-[12.5px] text-ink-soft">
            {compareSlugs.length} selected
            <span className="hidden font-mono text-[11px] text-muted-2 sm:inline">
              {" "}
              · {compareSlugs.join(", ")}
            </span>
          </span>
          <button
            className={buttonClassName("accent", undefined, "sm")}
            disabled={compareSlugs.length < 2}
            onClick={() => router.push(`/models/compare?models=${compareSlugs.join(",")}`)}
            type="button"
          >
            Compare
          </button>
          <Button onClick={() => setInternalSelected([])} size="sm" variant="ghost">
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Numbers-as-data render in mono per the design contract. */
function Num({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[12px] text-ink-soft">{children}</span>;
}

/** The catalog's one promo signal: cached input priced under fresh input. */
function CacheTag() {
  return (
    <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-accent">
      cache
    </span>
  );
}
