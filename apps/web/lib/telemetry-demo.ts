import {
  fillBucketStarts,
  type UsageRequestsQuery,
  type UsageTimeseriesQuery
} from "./gateway-telemetry";
import type {
  KeyModelUsage,
  KeyUsage,
  ProviderUsage,
  ServingWindow,
  Suggestion,
  UsageByKey,
  UsageByProvider,
  UsageLane,
  UsageRequestItem,
  UsageRequestsPage,
  UsageTimeseries
} from "./types";

// The signed-out Telemetry page's dataset: deterministic (hash-seeded, never
// Math.random at render), typed exactly as the gateway usage endpoints'
// responses, and filterable the same way, so the page renders demo data
// through the very same components and view state as real data. The demo IS
// the sales demo: recognizable models on both money lanes with the
// charged/estimated split correct (platform traffic charges credits, BYOK
// traffic carries a never-charged estimate), three plausible agents, and a
// request log.

type DemoModel = {
  model: string;
  provider: string;
  lane: UsageLane;
  /** Launch-catalog list prices, USD per million tokens. */
  usdPerMtokInput: number;
  usdPerMtokOutput: number;
  dailyRequests: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  typicalLatencyMs: number;
};

const DEMO_MODELS: DemoModel[] = [
  {
    model: "claude-sonnet-5",
    provider: "anthropic",
    lane: "platform",
    usdPerMtokInput: 3,
    usdPerMtokOutput: 15,
    dailyRequests: 420,
    meanInputTokens: 2_600,
    meanOutputTokens: 640,
    typicalLatencyMs: 2_400
  },
  {
    model: "claude-haiku-4-5",
    provider: "anthropic",
    lane: "platform",
    usdPerMtokInput: 1,
    usdPerMtokOutput: 5,
    dailyRequests: 960,
    meanInputTokens: 900,
    meanOutputTokens: 180,
    typicalLatencyMs: 700
  },
  {
    model: "gemini-2.5-flash",
    provider: "gemini",
    lane: "platform",
    usdPerMtokInput: 0.3,
    usdPerMtokOutput: 2.5,
    dailyRequests: 310,
    meanInputTokens: 1_400,
    meanOutputTokens: 260,
    typicalLatencyMs: 800
  },
  {
    model: "gpt-5.6-terra",
    provider: "openai",
    lane: "byok",
    usdPerMtokInput: 1,
    usdPerMtokOutput: 6,
    dailyRequests: 260,
    meanInputTokens: 3_100,
    meanOutputTokens: 720,
    typicalLatencyMs: 1_900
  },
  {
    model: "gpt-5.6-luna",
    provider: "openai",
    lane: "byok",
    usdPerMtokInput: 0.1,
    usdPerMtokOutput: 0.6,
    dailyRequests: 540,
    meanInputTokens: 700,
    meanOutputTokens: 120,
    typicalLatencyMs: 550
  }
];

export const DEMO_AGENTS: { id: string; label: string }[] = [
  { id: "0d3a4f9e-1111-4a61-9d5e-000000000001", label: "prod-agent" },
  { id: "0d3a4f9e-1111-4a61-9d5e-000000000002", label: "staging" },
  { id: "0d3a4f9e-1111-4a61-9d5e-000000000003", label: "cli" }
];

// A small pool of tool names the demo agents "call", so the Telemetry page's
// Tools-called surface has something organic to show. Names only, mirroring
// the real ledger's tools_used contract (never arguments).
const DEMO_TOOLS = [
  "web_search",
  "fetch_url",
  "run_python",
  "sql_query",
  "send_email"
] as const;

/** Distinct tool names for one demo request; empty for a request that called none. */
function demoToolsFor(index: number, failed: boolean): string[] {
  if (failed || seededUnit(`req:${index}:hastools`) < 0.55) {
    return [];
  }
  const count = 1 + Math.floor(seededUnit(`req:${index}:toolcount`) * 3);
  const picked: string[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const tool = DEMO_TOOLS[Math.floor(seededUnit(`req:${index}:tool:${slot}`) * DEMO_TOOLS.length)];
    if (!picked.includes(tool)) {
      picked.push(tool);
    }
  }
  return picked;
}

// Each model's traffic split across the agents; every row sums to 1 so the
// Agents table adds up to exactly what the timeseries shows.
const AGENT_SHARES: Record<string, [number, number, number]> = {
  "claude-sonnet-5": [0.7, 0.2, 0.1],
  "claude-haiku-4-5": [0, 0.3, 0.7],
  "gemini-2.5-flash": [0.5, 0.5, 0],
  "gpt-5.6-terra": [0.8, 0, 0.2],
  "gpt-5.6-luna": [0, 0.2, 0.8]
};

// FNV-1a over the key, folded to a unit float: cheap, stable, and obviously
// not a statistics-grade PRNG — it only has to make the demo look organic.
function seededUnit(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 8) / 0x01000000;
}

type DemoCell = {
  bucketStart: number;
  model: DemoModel;
  requestCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
};

// One (bucket, model) cell keyed by the bucket's wall-clock start, so a cell
// keeps its numbers across auto-refresh ticks instead of flickering.
function demoCell(model: DemoModel, bucketStart: number, bucketSeconds: number): DemoCell {
  const key = `${model.model}:${bucketStart}`;
  const scale = bucketSeconds / 86_400;
  const requestCount = Math.round(
    model.dailyRequests * scale * (0.65 + 0.7 * seededUnit(`${key}:n`))
  );
  const errorCount =
    requestCount > 0 && seededUnit(`${key}:e`) > 0.88
      ? Math.max(1, Math.round(requestCount * 0.03))
      : 0;
  return {
    bucketStart,
    model,
    requestCount,
    errorCount,
    inputTokens: Math.round(
      requestCount * model.meanInputTokens * (0.9 + 0.2 * seededUnit(`${key}:i`))
    ),
    outputTokens: Math.round(
      requestCount * model.meanOutputTokens * (0.9 + 0.2 * seededUnit(`${key}:o`))
    )
  };
}

function mixCostUsd(model: DemoModel, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * model.usdPerMtokInput + outputTokens * model.usdPerMtokOutput) / 1_000_000
  );
}

function agentShare(model: string, apiKeyId: string): number {
  const index = DEMO_AGENTS.findIndex((agent) => agent.id === apiKeyId);
  return index === -1 ? 0 : (AGENT_SHARES[model]?.[index] ?? 0);
}

function windowCells(window: ServingWindow, nowMs: number): DemoCell[] {
  const bucketSeconds = window === "24h" ? 3_600 : 86_400;
  const starts = fillBucketStarts(bucketSeconds, window, nowMs);
  return DEMO_MODELS.flatMap((model) =>
    starts.map((start) => demoCell(model, start, bucketSeconds))
  );
}

/** The demo counterpart of `GET /usage/timeseries`; every filter composes. */
export function demoTimeseries(query: UsageTimeseriesQuery, nowMs: number): UsageTimeseries {
  const window = query.window ?? "7d";
  const bucketSeconds = window === "24h" ? 3_600 : 86_400;
  const share = (model: string): number =>
    query.apiKeyId === undefined ? 1 : agentShare(model, query.apiKeyId);
  const buckets = windowCells(window, nowMs)
    .filter(
      (cell) =>
        (query.model === undefined || cell.model.model === query.model) &&
        (query.lane === undefined || cell.model.lane === query.lane) &&
        share(cell.model.model) > 0
    )
    .map((cell) => {
      const factor = share(cell.model.model);
      const requestCount = Math.round(cell.requestCount * factor);
      const inputTokens = Math.round(cell.inputTokens * factor);
      const outputTokens = Math.round(cell.outputTokens * factor);
      const cost = mixCostUsd(cell.model, inputTokens, outputTokens);
      return {
        bucket_start: new Date(cell.bucketStart).toISOString(),
        model: cell.model.model,
        lane: cell.model.lane,
        request_count: requestCount,
        error_count: Math.min(Math.round(cell.errorCount * factor), requestCount),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        // The split is the point: platform traffic charges credits, BYOK
        // traffic is a never-charged pass-through estimate.
        cost_usd: cell.model.lane === "platform" ? cost : 0,
        estimated_cost_usd: cell.model.lane === "byok" ? cost : 0
      };
    })
    .filter((bucket) => bucket.request_count > 0);
  return { window, bucket_seconds: bucketSeconds, buckets };
}

/** The demo counterpart of `GET /usage/by-key`: agent splits sum exactly. */

/** The deterministic per-provider rollup for the signed-out demo page. */
export function demoByProvider(window: ServingWindow, nowMs: number): UsageByProvider {
  const byProvider = new Map<string, DemoCell[]>();
  for (const cell of windowCells(window, nowMs)) {
    const cells = byProvider.get(cell.model.provider) ?? [];
    cells.push(cell);
    byProvider.set(cell.model.provider, cells);
  }
  const providers: ProviderUsage[] = [...byProvider.entries()].map(([provider, cells]) => {
    let costUsd = 0;
    let estimatedCostUsd = 0;
    for (const cell of cells) {
      const cost = mixCostUsd(cell.model, cell.inputTokens, cell.outputTokens);
      if (cell.model.lane === "platform") {
        costUsd += cost;
      } else {
        estimatedCostUsd += cost;
      }
    }
    return {
      provider,
      request_count: cells.reduce((sum, cell) => sum + cell.requestCount, 0),
      error_count: cells.reduce((sum, cell) => sum + cell.errorCount, 0),
      input_tokens: cells.reduce((sum, cell) => sum + cell.inputTokens, 0),
      output_tokens: cells.reduce((sum, cell) => sum + cell.outputTokens, 0),
      cost_usd: costUsd,
      estimated_cost_usd: estimatedCostUsd,
      last_used_at: new Date(nowMs).toISOString()
    };
  });
  providers.sort(
    (a, b) => b.cost_usd + b.estimated_cost_usd - (a.cost_usd + a.estimated_cost_usd)
  );
  return { window, providers };
}

export function demoByKey(window: ServingWindow, nowMs: number): UsageByKey {
  const totalsByModel = new Map<string, DemoCell[]>();
  for (const cell of windowCells(window, nowMs)) {
    const cells = totalsByModel.get(cell.model.model) ?? [];
    cells.push(cell);
    totalsByModel.set(cell.model.model, cells);
  }
  const keys: KeyUsage[] = DEMO_AGENTS.map((agent, agentIndex) => {
    const models: KeyModelUsage[] = [];
    for (const model of DEMO_MODELS) {
      const shares = AGENT_SHARES[model.model];
      if (shares === undefined || shares[agentIndex] === 0) {
        continue;
      }
      const cells = totalsByModel.get(model.model) ?? [];
      const total = (pick: (cell: DemoCell) => number): number =>
        cells.reduce((sum, cell) => sum + pick(cell), 0);
      // Largest-remainder-free integer split: earlier agents floor, the last
      // sharing agent takes what remains, so per-model sums match exactly.
      const split = (whole: number): number => {
        const before = shares
          .slice(0, agentIndex)
          .reduce((sum, share) => sum + Math.floor(whole * share), 0);
        const isLastSharer = shares.slice(agentIndex + 1).every((share) => share === 0);
        return isLastSharer ? whole - before : Math.floor(whole * shares[agentIndex]);
      };
      const inputTokens = split(total((cell) => cell.inputTokens));
      const outputTokens = split(total((cell) => cell.outputTokens));
      const cost = mixCostUsd(model, inputTokens, outputTokens);
      models.push({
        model: model.model,
        request_count: split(total((cell) => cell.requestCount)),
        error_count: split(total((cell) => cell.errorCount)),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: model.lane === "platform" ? cost : 0,
        estimated_cost_usd: model.lane === "byok" ? cost : 0
      });
    }
    return {
      api_key_id: agent.id,
      key_label: agent.label,
      models,
      totals: models.reduce(
        (totals, usage) => ({
          request_count: totals.request_count + usage.request_count,
          error_count: totals.error_count + usage.error_count,
          input_tokens: totals.input_tokens + usage.input_tokens,
          output_tokens: totals.output_tokens + usage.output_tokens,
          cost_usd: totals.cost_usd + usage.cost_usd,
          estimated_cost_usd: totals.estimated_cost_usd + usage.estimated_cost_usd
        }),
        {
          request_count: 0,
          error_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          estimated_cost_usd: 0
        }
      ),
      last_used_at: new Date(nowMs - (agentIndex + 1) * 4 * 60_000).toISOString()
    };
  });
  return { window, keys };
}

const DEMO_REQUEST_ROWS = 36;

/** The demo counterpart of `GET /usage/requests`, newest first, one page. */
export function demoRequests(query: UsageRequestsQuery, nowMs: number): UsageRequestsPage {
  const rows: UsageRequestItem[] = [];
  for (let index = 0; index < DEMO_REQUEST_ROWS; index += 1) {
    const model = pickWeighted(
      DEMO_MODELS,
      (candidate) => candidate.dailyRequests,
      seededUnit(`req:${index}:model`)
    );
    const shares = AGENT_SHARES[model.model] ?? [1, 0, 0];
    const agent = pickWeighted(
      DEMO_AGENTS,
      (_, agentIndex) => shares[agentIndex],
      seededUnit(`req:${index}:agent`)
    );
    const failed = seededUnit(`req:${index}:status`) > 0.94;
    const inputTokens = Math.round(
      model.meanInputTokens * (0.7 + 0.6 * seededUnit(`req:${index}:i`))
    );
    const outputTokens = failed
      ? 0
      : Math.round(model.meanOutputTokens * (0.7 + 0.6 * seededUnit(`req:${index}:o`)));
    const cost = failed ? 0 : mixCostUsd(model, inputTokens, outputTokens);
    rows.push({
      request_id: `demo-req-${String(index).padStart(3, "0")}`,
      model: model.model,
      provider: model.provider,
      lane: model.lane,
      api_key_id: agent.id,
      key_label: agent.label,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: model.lane === "platform" ? cost : 0,
      estimated_cost_usd: model.lane === "byok" ? cost : 0,
      real_cost_usd: cost,
      pricing_known: true,
      latency_ms: Math.round(model.typicalLatencyMs * (0.7 + 0.8 * seededUnit(`req:${index}:l`))),
      // First token lands well inside the total latency; failed rows never
      // streamed one, matching the ledger's NULL-not-zero contract.
      ttft_ms: failed
        ? null
        : Math.round(model.typicalLatencyMs * (0.15 + 0.25 * seededUnit(`req:${index}:t`))),
      status: failed ? "failed" : "completed",
      attempt_count: failed ? 2 : 1,
      created_at: new Date(nowMs - index * 9 * 60_000).toISOString(),
      tools_used: demoToolsFor(index, failed),
      failure_class: failed ? "provider_internal" : null,
      error_message: failed ? "The provider returned an internal error." : null,
      // Demo lineage: a few stable prompt groups so grouping renders.
      prompt_group: `dm${(index % 3) + 1}0000000000`.slice(0, 12),
      conversation_group: `dc${(index % 7) + 1}0000000000`.slice(0, 12)
    });
  }
  const filtered = rows.filter(
    (row) =>
      (query.model === undefined || row.model === query.model) &&
      (query.lane === undefined || row.lane === query.lane) &&
      (query.apiKeyId === undefined || row.api_key_id === query.apiKeyId) &&
      (query.status !== "error" || row.status !== "completed")
  );
  return { requests: filtered.slice(0, query.limit ?? 50), next_cursor: null };
}

function pickWeighted<T>(
  items: T[],
  weight: (item: T, index: number) => number,
  unit: number
): T {
  const total = items.reduce((sum, item, index) => sum + weight(item, index), 0);
  let remaining = unit * total;
  for (let index = 0; index < items.length; index += 1) {
    remaining -= weight(items[index], index);
    if (remaining <= 0) {
      return items[index];
    }
  }
  return items[items.length - 1];
}

/**
 * The two example suggestions the panel shows when no real ones exist (a
 * quiet org, or the signed-out demo). Each renders with an "Example" chip so
 * it can never read as advice derived from real usage.
 */
export const EXAMPLE_SUGGESTIONS: Suggestion[] = [
  {
    id: "example:cheaper-model",
    kind: "cheaper_model",
    title: "Try Claude Haiku 4.5 for small claude-sonnet-5 requests",
    body:
      "Most of this traffic is short requests. A cheaper model in the same family " +
      "typically handles requests of this size well.",
    estimated_monthly_savings_usd: "38.20",
    evidence: [
      "Example, this is what a suggestion looks like once you have usage.",
      "9,400 requests averaged about 900 input and 180 output tokens each.",
      "The same tokens at Claude Haiku 4.5's list prices would have cost about a third as much.",
      "Savings figures are estimates from your recent token mix, never invoiced amounts."
    ]
  },
  {
    id: "example:caching",
    kind: "caching",
    title: "Cache your repeated system prompt",
    body:
      "Requests that repeat a long shared prefix can serve it from the provider's " +
      "prompt cache at a fraction of the input price.",
    estimated_monthly_savings_usd: "12.60",
    evidence: [
      "Example, this is what a suggestion looks like once you have usage.",
      "A 2,000-token system prompt repeated across 6,000 requests is 12M input tokens a month.",
      "Cached input tokens are typically priced at about a tenth of the normal input rate."
    ]
  }
];
