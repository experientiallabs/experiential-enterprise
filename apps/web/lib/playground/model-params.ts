// The playground's per-model parameter contract: one place turns a catalog
// model's declared `supported_params` (and its modalities and prices) into the
// controls the rail renders, the request body those controls build, and the
// per-response cost the evidence card shows. The catalog row is the authority
// — a control appears only where the model declares it, so the panel adapts to
// whatever model is selected and never offers a parameter the gateway rejects.

import { cheapestInputMicro, cheapestOutputMicro } from "@/lib/models-catalog/format";
import type { CatalogEntry, CatalogModel } from "@/lib/models-catalog/types";

/** Sampling/behavior controls the playground exposes, in rail display order. */
export type ParamControlKind =
  | "temperature"
  | "top_p"
  | "max_tokens"
  | "reasoning_effort"
  | "seed"
  | "stop"
  | "tools"
  | "response_format";

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * The rail's editable state. Every field's absence (null / empty string /
 * false) means "the model's own default", and is then NOT sent — an untouched
 * control must never change what a request measures against.
 */
export type ParamState = {
  temperature: number | null;
  topP: number | null;
  /** Raw numeric text; "" is the model default. */
  maxTokens: string;
  reasoningEffort: ReasoningEffort | null;
  /** Raw integer text; "" is the model default. */
  seed: string;
  /** Comma-separated stop sequences; "" is none. */
  stop: string;
  /** Raw JSON text for the tools array; "" is none. */
  toolsJson: string;
  /** Ask for a JSON object response (response_format / structured outputs). */
  jsonMode: boolean;
};

export function emptyParamState(): ParamState {
  return {
    temperature: null,
    topP: null,
    maxTokens: "",
    reasoningEffort: null,
    seed: "",
    stop: "",
    toolsJson: "",
    jsonMode: false
  };
}

/**
 * The controls a model exposes, derived from its declared `supported_params`.
 * Temperature follows the gateway's own capability projection (supported
 * unless explicitly `false`); every other control appears only when the model
 * declares it `true`. `max_tokens` is always offered (bounded per model).
 */
export function availableControls(model: CatalogModel): ParamControlKind[] {
  const declared = model.supported_params;
  const controls: ParamControlKind[] = [];
  if (declared.temperature !== false) {
    controls.push("temperature");
  }
  if (declared.top_p === true) {
    controls.push("top_p");
  }
  controls.push("max_tokens");
  if (declared.reasoning === true) {
    controls.push("reasoning_effort");
  }
  if (declared.seed === true) {
    controls.push("seed");
  }
  if (declared.stop === true) {
    controls.push("stop");
  }
  if (declared.tools === true) {
    controls.push("tools");
  }
  if (declared.response_format === true || declared.structured_outputs === true) {
    controls.push("response_format");
  }
  return controls;
}

/** The result of turning the rail state into an OpenAI request-param object. */
export type BuiltParams =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Build the request-param object from the rail state, including only controls
 * the model supports AND the user actually set. Returns a typed error for the
 * two fields a user can enter malformed (tools JSON, integers) so the composer
 * can refuse the send instead of the gateway rejecting it mid-stream.
 */
export function buildRequestParams(model: CatalogModel, state: ParamState): BuiltParams {
  const controls = new Set(availableControls(model));
  const params: Record<string, unknown> = {};

  if (controls.has("temperature") && state.temperature !== null) {
    params.temperature = state.temperature;
  }
  if (controls.has("top_p") && state.topP !== null) {
    params.top_p = state.topP;
  }
  if (controls.has("max_tokens") && state.maxTokens.trim() !== "") {
    const parsed = Number.parseInt(state.maxTokens, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: "Max tokens must be a positive integer." };
    }
    // Never ask for more than the model can emit; an over-cap request would
    // 400 at the provider. The 32K fallback matches the composer's own guard.
    params.max_tokens = Math.min(parsed, model.max_output_tokens ?? 32_768);
  }
  if (controls.has("reasoning_effort") && state.reasoningEffort !== null) {
    params.reasoning_effort = state.reasoningEffort;
  }
  if (controls.has("seed") && state.seed.trim() !== "") {
    const parsed = Number.parseInt(state.seed, 10);
    if (!Number.isInteger(parsed)) {
      return { ok: false, error: "Seed must be an integer." };
    }
    params.seed = parsed;
  }
  if (controls.has("stop") && state.stop.trim() !== "") {
    const sequences = state.stop
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (sequences.length > 0) {
      params.stop = sequences;
    }
  }
  if (controls.has("tools") && state.toolsJson.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(state.toolsJson);
    } catch {
      return { ok: false, error: "Tools must be valid JSON." };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "Tools must be a JSON array of tool definitions." };
    }
    params.tools = parsed;
    params.tool_choice = "auto";
  }
  if (controls.has("response_format") && state.jsonMode) {
    params.response_format = { type: "json_object" };
  }
  return { ok: true, params };
}

/** Attachment input kinds the playground can offer for a model. */
export type AttachmentModality = "image" | "pdf";

/**
 * The attachment affordances a model's input modalities admit. Text input is
 * always available and is not an attachment, so it is not listed here.
 */
export function supportedAttachmentModalities(model: CatalogModel): AttachmentModality[] {
  const declared = new Set(model.input_modalities.map((modality) => modality.toLowerCase()));
  const modalities: AttachmentModality[] = [];
  if (declared.has("image")) {
    modalities.push("image");
  }
  if (declared.has("pdf") || declared.has("document") || declared.has("file")) {
    modalities.push("pdf");
  }
  return modalities;
}

/**
 * Per-response cost from the model's cheapest known route price and the
 * gateway's reported token usage. Null when either price or either token count
 * is unknown — a priced call must never read as free, and an unpriced route
 * must never read as spend (lib/money.ts renders null as "unpriced").
 *
 * Prices are integer micro-USD per million tokens, so cost in USD is
 * tokens * micro_per_million / 1e12.
 */
export function estimateResponseCostUsd(
  entry: CatalogEntry,
  promptTokens: number | null,
  completionTokens: number | null
): number | null {
  const inputMicro = cheapestInputMicro(entry);
  const outputMicro = cheapestOutputMicro(entry);
  if (
    inputMicro === null ||
    outputMicro === null ||
    promptTokens === null ||
    completionTokens === null
  ) {
    return null;
  }
  return (promptTokens * inputMicro + completionTokens * outputMicro) / 1_000_000_000_000;
}
