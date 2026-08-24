// Display vocabulary for the models catalog: one place turns the catalog
// API's raw fields (token counts, provider enums, stats) into the strings
// every catalog surface renders, so the list, detail, and compare pages can
// never disagree about what a provider is called or how 1,048,576 tokens
// reads. Dollar math stays in lib/money.ts.

import type { CatalogDeployment, CatalogEntry, CatalogProvider } from "./types";

/** User-facing provider names (the wire enum is snake_case). */
export const PROVIDER_LABELS: Record<CatalogProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  azure_openai: "Azure Foundry",
  openrouter: "OpenRouter",
  bedrock: "Bedrock",
  local: "Local",
  fireworks: "Fireworks",
  modal: "Modal",
  experiential_cloud: "Experiential Cloud"
};

/** Product sentence used wherever Experiential Cloud is introduced. */
export const EXPERIENTIAL_CLOUD_DESCRIPTION =
  "Experiential Cloud is a curated collection of models, hosted and optimized by Experiential Labs.";

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as CatalogProvider] ?? provider;
}

/** Customer-facing provider introduction, or null when the label is enough. */
export function providerDescription(provider: string): string | null {
  return provider === "experiential_cloud" ? EXPERIENTIAL_CLOUD_DESCRIPTION : null;
}

/** Token counts as catalog shorthand: 262144 -> "262K", 1048576 -> "1M". */
export function formatTokenCount(tokens: number | null | undefined): string {
  if (tokens === undefined || tokens === null) {
    return "—";
  }
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${trimmed(millions, millions >= 10 ? 0 : 2)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

/** Uptime percentage; the API reports 0..100 or null for no measurement. */
export function formatUptime(uptime: number | null | undefined): string {
  if (uptime === undefined || uptime === null) {
    return "—";
  }
  return `${trimmed(uptime, uptime >= 99.95 ? 2 : 1)}%`;
}

/** Throughput in tokens per second. */
export function formatThroughput(tps: number | null | undefined): string {
  if (tps === undefined || tps === null) {
    return "—";
  }
  return `${trimmed(tps, tps >= 100 ? 0 : 1)} tok/s`;
}

/** p50 time to first token, milliseconds. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === undefined || ms === null) {
    return "—";
  }
  if (ms >= 1_000) {
    return `${trimmed(ms / 1_000, 2)}s`;
  }
  return `${Math.round(ms)}ms`;
}

/** Release dates render as a month-level fact ("Mar 2026"), not a timestamp. */
export function formatReleaseDate(isoDate: string | null | undefined): string {
  if (isoDate === undefined || isoDate === null) {
    return "—";
  }
  const [year, month] = isoDate.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return "—";
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[month - 1]} ${year}`;
}

/** supported_params keys that are true, in a stable display order. */
export function supportedParamList(params: Record<string, unknown>): string[] {
  const order = [
    "tools",
    "reasoning",
    "temperature",
    "top_p",
    "response_format",
    "structured_outputs",
    "stop",
    "seed",
    "logprobs"
  ];
  const enabled = Object.keys(params).filter((key) => params[key] === true);
  return enabled.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b);
  });
}

/** Short chip text for a supported_params key ("structured_outputs" -> "structured"). */
export function paramChipLabel(param: string): string {
  const labels: Record<string, string> = {
    tools: "tools",
    reasoning: "reasoning",
    temperature: "temp",
    top_p: "top_p",
    response_format: "response format",
    structured_outputs: "structured",
    stop: "stop",
    seed: "seed",
    logprobs: "logprobs"
  };
  return labels[param] ?? param.replaceAll("_", " ");
}

/**
 * A deployment is discounted when its cached-input price undercuts its input
 * price — the catalog's one observable promo signal (OpenRouter-style cache
 * discounts). Unknown prices never count as a discount.
 */
export function hasCacheDiscount(deployment: CatalogDeployment): boolean {
  return (
    deployment.input_micro_usd_per_million !== null &&
    deployment.cached_input_micro_usd_per_million !== null &&
    deployment.cached_input_micro_usd_per_million < deployment.input_micro_usd_per_million
  );
}

/** Cheapest known input price across a model's routes; null when unpriced. */
export function cheapestInputMicro(entry: CatalogEntry): number | null {
  return minKnown(entry.providers.map((row) => row.input_micro_usd_per_million));
}

/** Cheapest known output price across a model's routes; null when unpriced. */
export function cheapestOutputMicro(entry: CatalogEntry): number | null {
  return minKnown(entry.providers.map((row) => row.output_micro_usd_per_million));
}

/** Best (highest) known throughput across a model's routes. */
export function bestThroughput(entry: CatalogEntry): number | null {
  return maxKnown(entry.providers.map((row) => row.throughput_tps));
}

/** Best (highest) known 30-day uptime across a model's routes. */
export function bestUptime(entry: CatalogEntry): number | null {
  return maxKnown(entry.providers.map((row) => row.uptime_30d));
}

function minKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.min(...known);
}

function maxKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}

function trimmed(value: number, decimals: number): string {
  return value
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}
