import { describe, expect, it } from "vitest";

import {
  catalogCategories,
  catalogProviders,
  countActiveFilters,
  EMPTY_FILTERS,
  filterEntries,
  filterRoutes
} from "@/components/models-catalog/filtering";
import {
  bestThroughput,
  cheapestInputMicro,
  EXPERIENTIAL_CLOUD_DESCRIPTION,
  formatLatency,
  formatReleaseDate,
  formatThroughput,
  formatTokenCount,
  formatUptime,
  hasCacheDiscount,
  providerDescription,
  providerLabel,
  supportedParamList
} from "@/lib/models-catalog/format";
import { formatPerMillionUsd } from "@/lib/money";
import { makeDeployment, makeEntry } from "./models-catalog-fixtures";

const NOW = new Date("2026-08-19T00:00:00Z");

const CATALOG = [
  makeEntry(
    {
      id: "m-opus",
      slug: "claude-opus-5",
      display_name: "Claude Opus 5",
      preferred_rank: 1,
      context_window: 500_000,
      input_modalities: ["text", "image", "pdf"],
      supported_params: { tools: true, reasoning: true, temperature: true },
      category: "frontier",
      release_date: "2026-06-01"
    },
    [
      {
        id: "opus-anthropic",
        provider: "anthropic",
        input_micro_usd_per_million: 10_000_000,
        cached_input_micro_usd_per_million: 1_000_000,
        throughput_tps: 60
      },
      {
        id: "opus-bedrock",
        provider: "bedrock",
        input_micro_usd_per_million: 12_000_000,
        cached_input_micro_usd_per_million: null,
        throughput_tps: 45
      }
    ]
  ),
  makeEntry(
    {
      id: "m-cheap",
      slug: "deepseek-v4-flash",
      display_name: "DeepSeek V4 Flash",
      context_window: 128_000,
      supported_params: { tools: true },
      category: "value",
      release_date: "2025-01-15"
    },
    [{ id: "ds-or", provider: "openrouter", input_micro_usd_per_million: 74_200 }]
  ),
  makeEntry(
    {
      id: "m-unknown",
      slug: "mystery",
      display_name: "Mystery",
      context_window: null,
      supported_params: {},
      release_date: null
    },
    []
  )
];

describe("catalog filtering", () => {
  it("passes everything through empty filters", () => {
    expect(filterEntries(CATALOG, EMPTY_FILTERS, NOW)).toHaveLength(3);
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
  });

  it("matches free-text against name, slug, and provider", () => {
    expect(
      filterEntries(CATALOG, { ...EMPTY_FILTERS, query: "bedrock" }, NOW).map((e) => e.model.slug)
    ).toEqual(["claude-opus-5"]);
    expect(
      filterEntries(CATALOG, { ...EMPTY_FILTERS, query: "FLASH" }, NOW).map((e) => e.model.slug)
    ).toEqual(["deepseek-v4-flash"]);
  });

  it("filters by modality, provider, params, category, and context floor", () => {
    expect(
      filterEntries(CATALOG, { ...EMPTY_FILTERS, modalities: ["pdf"] }, NOW)
    ).toHaveLength(1);
    expect(
      filterEntries(CATALOG, { ...EMPTY_FILTERS, providers: ["openrouter"] }, NOW).map(
        (e) => e.model.slug
      )
    ).toEqual(["deepseek-v4-flash"]);
    expect(filterEntries(CATALOG, { ...EMPTY_FILTERS, params: ["reasoning"] }, NOW)).toHaveLength(1);
    expect(filterEntries(CATALOG, { ...EMPTY_FILTERS, category: "value" }, NOW)).toHaveLength(1);
    // A null context window never satisfies a floor.
    expect(filterEntries(CATALOG, { ...EMPTY_FILTERS, minContext: 130_000 }, NOW)).toHaveLength(1);
  });

  it("prices by the cheapest route and treats unpriced as never matching a cap", () => {
    const cheap = filterEntries(CATALOG, { ...EMPTY_FILTERS, maxInputMicro: 100_000 }, NOW);
    expect(cheap.map((e) => e.model.slug)).toEqual(["deepseek-v4-flash"]);
  });

  it("discounts mean cached input priced under fresh input, unknowns excluded", () => {
    const discounted = filterEntries(CATALOG, { ...EMPTY_FILTERS, discountsOnly: true }, NOW);
    expect(discounted.map((e) => e.model.slug)).toEqual(["claude-opus-5"]);
    expect(hasCacheDiscount(makeDeployment({ cached_input_micro_usd_per_million: null }))).toBe(
      false
    );
  });

  it("model age needs a known release date", () => {
    const young = filterEntries(CATALOG, { ...EMPTY_FILTERS, maxAgeDays: 120 }, NOW);
    expect(young.map((e) => e.model.slug)).toEqual(["claude-opus-5"]);
  });

  it("expands routes per provider and narrows them by the provider filter", () => {
    const all = filterRoutes(CATALOG, EMPTY_FILTERS, NOW);
    expect(all).toHaveLength(3);
    // "Claude by Anthropic or by Bedrock": each provider row filterable alone.
    const bedrockOnly = filterRoutes(CATALOG, { ...EMPTY_FILTERS, providers: ["bedrock"] }, NOW);
    expect(bedrockOnly).toHaveLength(1);
    expect(bedrockOnly[0].deployment.id).toBe("opus-bedrock");
    // The discount filter narrows to the discounted route itself.
    const discounted = filterRoutes(CATALOG, { ...EMPTY_FILTERS, discountsOnly: true }, NOW);
    expect(discounted.map((row) => row.deployment.id)).toEqual(["opus-anthropic"]);
  });

  it("lists experiential_cloud first in the routes view even when it is last in input", () => {
    const entry = makeEntry({ id: "m-flash", slug: "deepseek-v4-flash-order", preferred_rank: 1 }, [
      { id: "or-fast", provider: "openrouter", throughput_tps: 200 },
      { id: "ec-slow", provider: "experiential_cloud", throughput_tps: 40 }
    ]);
    expect(filterRoutes([entry], EMPTY_FILTERS, NOW).map((row) => row.deployment.id)).toEqual([
      "ec-slow",
      "or-fast"
    ]);
  });

  it("derives menus from the data", () => {
    expect(catalogProviders(CATALOG)).toEqual(["anthropic", "bedrock", "openrouter"]);
    expect(catalogCategories(CATALOG)).toEqual(["frontier", "value"]);
  });
});

describe("catalog display vocabulary", () => {
  it("renders micro-USD per million as $/M with unknowns as — , never $0", () => {
    expect(formatPerMillionUsd(541_500)).toBe("$0.54");
    expect(formatPerMillionUsd(74_200)).toBe("$0.074");
    expect(formatPerMillionUsd(2_280_000)).toBe("$2.28");
    expect(formatPerMillionUsd(30_000_000)).toBe("$30");
    // Column-stable cents: $1.40, never a trimmed $1.4.
    expect(formatPerMillionUsd(1_400_000)).toBe("$1.40");
    expect(formatPerMillionUsd(null)).toBe("—");
    expect(formatPerMillionUsd(undefined)).toBe("—");
    // A real but sub-display price says so instead of rounding to zero.
    expect(formatPerMillionUsd(100)).toBe("<$0.001");
    // A genuinely free route is honest about it.
    expect(formatPerMillionUsd(0)).toBe("$0");
  });

  it("formats catalog facts with — for unknowns", () => {
    expect(formatTokenCount(262_144)).toBe("262K");
    expect(formatTokenCount(1_048_576)).toBe("1.05M");
    expect(formatTokenCount(null)).toBe("—");
    expect(formatUptime(99.98)).toBe("99.98%");
    expect(formatUptime(97.4)).toBe("97.4%");
    expect(formatUptime(null)).toBe("—");
    expect(formatThroughput(45.5)).toBe("45.5 tok/s");
    expect(formatThroughput(null)).toBe("—");
    expect(formatLatency(640)).toBe("640ms");
    expect(formatLatency(1_500)).toBe("1.5s");
    expect(formatReleaseDate("2026-06-01")).toBe("Jun 2026");
    expect(formatReleaseDate(null)).toBe("—");
    expect(providerLabel("azure_openai")).toBe("Azure Foundry");
    expect(providerLabel("experiential_cloud")).toBe("Experiential Cloud");
    expect(providerDescription("experiential_cloud")).toBe(
      "Experiential Cloud is a curated collection of models, hosted and optimized by Experiential Labs."
    );
    expect(providerDescription("experiential_cloud")).toBe(EXPERIENTIAL_CLOUD_DESCRIPTION);
    expect(providerDescription("openai")).toBeNull();
  });

  it("aggregates per-model stats across routes without zero-filling", () => {
    expect(cheapestInputMicro(CATALOG[0])).toBe(10_000_000);
    expect(bestThroughput(CATALOG[0])).toBe(60);
    expect(cheapestInputMicro(CATALOG[2])).toBeNull();
    expect(bestThroughput(CATALOG[2])).toBeNull();
  });

  it("lists supported params in a stable order", () => {
    expect(
      supportedParamList({ temperature: true, tools: true, seed: false, reasoning: true })
    ).toEqual(["tools", "reasoning", "temperature"]);
  });
});
