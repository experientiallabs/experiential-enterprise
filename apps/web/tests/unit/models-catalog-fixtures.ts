// Shared catalog fixtures for the models-catalog suites: tiny factories over
// the API view shapes (lib/models-catalog/types.ts) so each test states only
// the fields it is about.

import type {
  CatalogDeployment,
  CatalogEntry,
  CatalogModel,
  ModelBenchmark,
  ModelDetail,
  WaterfallRung
} from "@/lib/models-catalog/types";

export function makeModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "model-1",
    slug: "test-model",
    display_name: "Test Model",
    description: null,
    icon: null,
    release_date: null,
    context_window: 131072,
    max_output_tokens: 16384,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_params: { tools: true, temperature: true },
    category: null,
    tags: [],
    owning_org_id: null,
    preferred_rank: null,
    status: "active",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides
  };
}

export function makeDeployment(overrides: Partial<CatalogDeployment> = {}): CatalogDeployment {
  return {
    id: "dep-1",
    model_id: "model-1",
    provider: "openai",
    provider_model_id: "test-model",
    base_url: null,
    region: null,
    api_version: null,
    owning_org_id: null,
    provider_connection_id: null,
    billing_source: "customer_managed",
    input_micro_usd_per_million: 2_000_000,
    cached_input_micro_usd_per_million: null,
    output_micro_usd_per_million: 8_000_000,
    reasoning_micro_usd_per_million: null,
    pricing_source: "provider-docs",
    pricing_effective_at: "2026-08-01T00:00:00Z",
    capabilities: {},
    uptime_30d: null,
    throughput_tps: null,
    latency_p50_ms: null,
    stats_source: null,
    status: "active",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides
  };
}

export function makeEntry(
  model: Partial<CatalogModel> = {},
  providers: Array<Partial<CatalogDeployment>> = [{}]
): CatalogEntry {
  const built = makeModel(model);
  return {
    model: built,
    providers: providers.map((overrides, index) =>
      makeDeployment({
        id: `${built.id}-dep-${index}`,
        model_id: built.id,
        provider_model_id: built.slug,
        ...overrides
      })
    )
  };
}

export function makeRung(overrides: Partial<WaterfallRung> = {}): WaterfallRung {
  return {
    id: "rung-1",
    position: 0,
    model_provider_id: "model-1-dep-0",
    provider: "openai",
    provider_model_id: "test-model",
    base_url: null,
    status: "active",
    ...overrides
  };
}

export function makeBenchmark(overrides: Partial<ModelBenchmark> = {}): ModelBenchmark {
  return {
    benchmark: "mmlu-pro",
    display_name: "MMLU-Pro",
    unit: "percent",
    higher_is_better: true,
    score: 81.3,
    source: "vendor",
    source_url: "https://example.com/model-card",
    retrieved_at: "2026-08-20T00:00:00Z",
    ...overrides
  };
}

export function makeDetail(
  entry: CatalogEntry,
  rungs?: WaterfallRung[],
  extras: Partial<Pick<ModelDetail, "huggingface_url" | "release_url" | "benchmarks">> = {}
): ModelDetail {
  return {
    huggingface_url: null,
    release_url: null,
    benchmarks: [],
    ...extras,
    model: entry.model,
    providers: entry.providers,
    default_waterfall:
      rungs ??
      entry.providers.map((deployment, index) =>
        makeRung({
          id: `rung-${index}`,
          position: index,
          model_provider_id: deployment.id,
          provider: deployment.provider,
          provider_model_id: deployment.provider_model_id
        })
      )
  };
}
