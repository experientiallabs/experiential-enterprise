import { describe, expect, it } from "vitest";

import {
  availableControls,
  buildRequestParams,
  emptyParamState,
  estimateResponseCostUsd,
  supportedAttachmentModalities,
  type ParamState
} from "@/lib/playground/model-params";
import type { CatalogDeployment, CatalogEntry, CatalogModel } from "@/lib/models-catalog/types";

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "m-1",
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    description: null,
    icon: null,
    release_date: null,
    context_window: 400_000,
    max_output_tokens: 64_000,
    input_modalities: ["text"],
    output_modalities: ["text"],
    supported_params: {},
    category: null,
    tags: [],
    owning_org_id: null,
    preferred_rank: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function deployment(overrides: Partial<CatalogDeployment> = {}): CatalogDeployment {
  return {
    id: "d-1",
    model_id: "m-1",
    provider: "openai",
    provider_model_id: "gpt-5.6-sol",
    base_url: null,
    region: null,
    api_version: null,
    owning_org_id: null,
    provider_connection_id: null,
    billing_source: "host_managed",
    input_micro_usd_per_million: null,
    cached_input_micro_usd_per_million: null,
    output_micro_usd_per_million: null,
    reasoning_micro_usd_per_million: null,
    pricing_source: null,
    pricing_effective_at: null,
    capabilities: {},
    uptime_30d: null,
    throughput_tps: null,
    latency_p50_ms: null,
    stats_source: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function entry(m: CatalogModel, providers: CatalogDeployment[]): CatalogEntry {
  return { model: m, providers };
}

describe("availableControls", () => {
  it("offers temperature by default and hides it only when explicitly false", () => {
    expect(availableControls(model())).toContain("temperature");
    expect(availableControls(model({ supported_params: { temperature: false } }))).not.toContain(
      "temperature"
    );
  });

  it("gates optional controls on their declared support", () => {
    const controls = availableControls(
      model({
        supported_params: {
          top_p: true,
          reasoning: true,
          seed: true,
          stop: true,
          tools: true,
          structured_outputs: true
        }
      })
    );
    expect(controls).toEqual(
      expect.arrayContaining([
        "top_p",
        "reasoning_effort",
        "seed",
        "stop",
        "tools",
        "response_format"
      ])
    );
  });

  it("always offers max_tokens and never an undeclared param", () => {
    const controls = availableControls(model({ supported_params: {} }));
    expect(controls).toContain("max_tokens");
    expect(controls).not.toContain("tools");
    expect(controls).not.toContain("reasoning_effort");
  });
});

describe("buildRequestParams", () => {
  function state(overrides: Partial<ParamState>): ParamState {
    return { ...emptyParamState(), ...overrides };
  }

  it("sends only controls the model supports and the user set", () => {
    const m = model({ supported_params: { top_p: true } });
    const result = buildRequestParams(m, state({ temperature: 0.7, topP: 0.9 }));
    expect(result).toEqual({ ok: true, params: { temperature: 0.7, top_p: 0.9 } });
  });

  it("omits an unsupported control even when the state carries a value", () => {
    const m = model({ supported_params: { temperature: false } });
    const result = buildRequestParams(m, state({ temperature: 0.7, maxTokens: "100" }));
    expect(result).toEqual({ ok: true, params: { max_tokens: 100 } });
  });

  it("caps max_tokens at the model's output ceiling", () => {
    const m = model({ max_output_tokens: 8000 });
    const result = buildRequestParams(m, state({ maxTokens: "99999" }));
    expect(result).toEqual({ ok: true, params: { max_tokens: 8000 } });
  });

  it("splits stop sequences and forwards reasoning effort and JSON mode", () => {
    const m = model({ supported_params: { stop: true, reasoning: true, response_format: true } });
    const result = buildRequestParams(
      m,
      state({ stop: "END, STOP ,", reasoningEffort: "high", jsonMode: true })
    );
    expect(result).toEqual({
      ok: true,
      params: {
        stop: ["END", "STOP"],
        reasoning_effort: "high",
        response_format: { type: "json_object" }
      }
    });
  });

  it("parses a tools array and reports invalid JSON as a typed error", () => {
    const m = model({ supported_params: { tools: true } });
    const good = buildRequestParams(m, state({ toolsJson: '[{"type":"function"}]' }));
    expect(good).toEqual({ ok: true, params: { tools: [{ type: "function" }], tool_choice: "auto" } });

    expect(buildRequestParams(m, state({ toolsJson: "{not json" }))).toEqual({
      ok: false,
      error: "Tools must be valid JSON."
    });
    expect(buildRequestParams(m, state({ toolsJson: '{"a":1}' }))).toEqual({
      ok: false,
      error: "Tools must be a JSON array of tool definitions."
    });
  });
});

describe("supportedAttachmentModalities", () => {
  it("maps input modalities to attachment affordances", () => {
    expect(supportedAttachmentModalities(model({ input_modalities: ["text"] }))).toEqual([]);
    expect(
      supportedAttachmentModalities(model({ input_modalities: ["text", "image", "pdf"] }))
    ).toEqual(["image", "pdf"]);
    expect(
      supportedAttachmentModalities(model({ input_modalities: ["text", "document"] }))
    ).toEqual(["pdf"]);
  });
});

describe("estimateResponseCostUsd", () => {
  it("prices from the cheapest route and the reported tokens", () => {
    // $1/M input, $6/M output → 1000 in + 500 out = $0.001 + $0.003 = $0.004.
    const priced = entry(model(), [
      deployment({ input_micro_usd_per_million: 1_000_000, output_micro_usd_per_million: 6_000_000 })
    ]);
    expect(estimateResponseCostUsd(priced, 1000, 500)).toBeCloseTo(0.004, 9);
  });

  it("returns null when a price or a token count is unknown", () => {
    const unpriced = entry(model(), [deployment()]);
    expect(estimateResponseCostUsd(unpriced, 1000, 500)).toBeNull();
    const priced = entry(model(), [
      deployment({ input_micro_usd_per_million: 1_000_000, output_micro_usd_per_million: 6_000_000 })
    ]);
    expect(estimateResponseCostUsd(priced, null, 500)).toBeNull();
  });
});
