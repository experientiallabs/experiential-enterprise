// Contract types for the optimized-model product object (the backend calls it
// an ENDPOINT: world model + learned inference policy + eval evidence + serving
// URL; the UI labels it a "model"). Shapes follow the D-ENDPOINT-TYPES and
// D-REPORT contracts in the cross-chat decision log; the live implementation is
// the serving wrapper behind lib/endpoints/live-provider.ts.

export type EndpointStatus = "ingesting" | "building" | "optimizing" | "ready" | "failed";

export type ModelTier = "frontier" | "open";

export type ModelRef = {
  /** Provider-qualified model id, e.g. "zai/glm-5.2". */
  model_id: string;
  /** Customer-facing label, e.g. "GLM-5.2". */
  label: string;
  tier: ModelTier;
};

/**
 * One candidate model's closed-loop eval row on the endpoint's held-out
 * scenarios. Mirrors wmh CandidateResult (wmh/optimize/report.py); the fields
 * the current mock does not populate are optional so a partial report from the
 * backend (once the optimizer writer lands) still types and renders.
 */
export type CandidateResult = ModelRef & {
  /** Verifier-scored task success on held-out scenarios, 0..1. */
  accuracy: number;
  /** Fraction of scored episodes that hit the success bar, 0..1. */
  success_rate?: number;
  /** Real measured cost of one run's eval calls, cache-adjusted. */
  cost_per_run_usd: number;
  latency_p50_ms: number;
  latency_p95_ms?: number;
  /** Episodes that produced a reward and back the row's averages. */
  scored_episodes?: number;
  /** Episodes skipped (no reward); counted, never averaged in as zeros. */
  unscored_episodes?: number;
};

/** Share of serving traffic each model takes under the learned policy. */
export type ModelMixEntry = {
  model_id: string;
  /** 0..1; entries sum to 1. */
  share: number;
};

export type ImprovementReport = {
  endpoint_id: string;
  generated_at: string;
  scenario_count: number;
  /**
   * Honesty label rendered verbatim next to accuracy claims, e.g.
   * "on 128 held-out scenarios reconstructed from your traces".
   */
  scenario_label: string;
  /** The frontier reference model every claim is measured against. */
  baseline: ModelRef;
  headline: {
    accuracy: number;
    baseline_accuracy: number;
    cost_per_run_usd: number;
    baseline_cost_per_run_usd: number;
    latency_p50_ms: number;
    baseline_latency_p50_ms: number;
    latency_p95_ms?: number;
    baseline_latency_p95_ms?: number;
    /** Scenarios scored on BOTH sides: what the headline numbers cover. */
    scenarios_compared?: number;
    /** Scenarios held out of the comparison because one side went unscored. */
    scenarios_excluded?: number;
  };
  candidates: CandidateResult[];
  model_mix: ModelMixEntry[];
  /**
   * Per-run token workload behind the cost figures. Platform-only enrichment
   * (not in the wmh report shape), so a backend report may omit it; consumers
   * guard the access.
   */
  workload?: {
    calls_per_run: number;
    input_tokens: number;
    output_tokens: number;
  };
  /** Stated cost basis, e.g. "cache-adjusted, measured on multi-turn eval traffic". */
  cost_assumptions: string;
  /**
   * Declared by "before optimization" snapshots only. The UI keys its
   * "serving its baseline model" note on THIS provenance bit, never on zero
   * deltas: an optimizer-written report whose fitted result equals the
   * baseline is a measurement, not an unoptimized state.
   */
  baseline_only?: boolean;
};

/** The bold numbers surfaced on list rows before opening the full report. */
export type EndpointHeadline = {
  accuracy: number;
  /**
   * The frontier baseline's task success on the same scenarios, when the
   * stored report measured it: what lets a card state the accuracy DELTA the
   * way the public door does instead of a bare absolute.
   */
  baseline_accuracy?: number;
  cost_per_run_usd: number;
  /** 0..1 saving vs the baseline frontier reference. */
  savings_fraction: number;
  /**
   * 0..1 p50 per-run latency saving vs the report's baseline. Present only
   * when the stored report measured both sides; the cards state the absence
   * instead of showing a zero.
   */
  latency_savings_fraction?: number;
  /** Mirrors ImprovementReport.baseline_only for list rows. */
  baseline_only?: boolean;
};

// Historical endpoint rows use this name for the pre-cutover starter. The
// frozen serving snapshot preserves the value; current Project setup does not
// auto-create or mutate legacy endpoints.
export const AUTO_PROVISIONED_ENDPOINT_NAME = "default";

export type EndpointSummary = {
  id: string;
  /** Per-org-unique slug, same convention as world model names. */
  name: string;
  status: EndpointStatus;
  /** Null until the pipeline's world-model stage has completed. */
  world_model_id: string | null;
  created_at: string;
  /** Null until the improvement report exists. */
  headline: EndpointHeadline | null;
  /**
   * D-DEFAULTS: a platform default surfaced read-only from the central catalog
   * org. Optional: an API predating the flag simply omits it.
   */
  is_catalog_default?: boolean;
  /**
   * D-LOCAL-PUSH: "local-push" when the endpoint or its evidence arrived
   * through the key-authenticated publish surface (measured on the operator's
   * machine, uploaded with `wmo push`). Optional: older APIs omit it.
   */
  origin?: string | null;
  /**
   * The published default this endpoint is a CLONE of (its slug), stamped at
   * adopt time; null/absent for everything created fresh. List rows use it to
   * carry the default's identity without guessing from simulation provenance.
   */
  embodies_default?: string | null;
};

/** The simulation an endpoint was built from: the link plus its build facts. */
export type EndpointWorldModel = {
  id: string;
  slug: string;
  label: string;
  /** Simulation lifecycle status, e.g. "ready". Absent on older payloads. */
  status?: string;
  /** When the simulation was created. Absent on older payloads. */
  created_at?: string | null;
};

export type Endpoint = EndpointSummary & {
  serving_base_url: string;
  /** Why the pipeline stopped (recorded ingest/build error); null unless status is "failed". */
  error: string | null;
  report: ImprovementReport | null;
  policy_summary: { clusters: number; models: string[] } | null;
  /** Absent on payloads written before the field existed; null when the simulation is gone. */
  world_model?: EndpointWorldModel | null;
  /** What serving would do right now; absent on payloads predating the field. */
  serving_state?: ServingState;
  /**
   * Why the deployment cannot serve this endpoint's model (missing provider
   * variables, named never echoed); null/absent when serving can construct it.
   */
  serving_unavailable_reason?: string | null;
};

// --- The dashboard timeseries read (GET .../timeseries) ---

/** One windowed bucket of an endpoint's serving totals. */
export type EndpointTimeseriesBucket = {
  bucket_start: string;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** The same tokens at the frontier reference price (zero-cost rows excluded). */
  baseline_cost_usd: number;
  /** Null while any of the bucket's rows is unpriced: no honest saving to state. */
  saved_usd: number | null;
  unpriced_count: number;
};

export type EndpointModelSeriesBucket = {
  bucket_start: string;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

/** One routed model's windowed series, for the per-model usage chart. */
export type EndpointModelSeries = {
  name: string;
  label: string;
  buckets: EndpointModelSeriesBucket[];
};

/**
 * One row of "where your traffic goes": the trained allocation calibrated by
 * real serving (the prior carries a fixed pseudo-request weight server-side).
 */
export type TrafficMixEntry = {
  name: string;
  label: string;
  share: number;
  /** The training-time allocation, or null for a model the report never named. */
  trained_share: number | null;
  request_count: number;
};

export type EndpointTimeseries = {
  endpoint: string;
  window: "24h" | "7d" | "30d";
  bucket_seconds: number;
  buckets: EndpointTimeseriesBucket[];
  models: EndpointModelSeries[];
  traffic_mix: TrafficMixEntry[];
  /** All-time totals; the headline tokens figure reads from here. */
  lifetime: {
    request_count: number;
    error_count: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    unpriced_count: number;
  };
};

// --- Per-endpoint settings (the Config tab; GET/PUT .../settings) ---

/**
 * What serving would do with a request right now: paused and the two reached
 * ceilings replace "Ready" in the header dot.
 */
export type ServingState =
  | "serving"
  | "paused"
  | "spend_limit"
  | "token_limit"
  /** The served model's provider cannot be constructed in this deployment. */
  | "unserveable";

export type EndpointSettings = {
  endpoint: string;
  /** Whether telemetry stores request/response bodies (metering always stays). */
  store_bodies: boolean;
  /** A paused endpoint refuses every request until resumed. */
  paused: boolean;
  /** Monthly (calendar, UTC) spend ceiling; null = none. Serving refuses at it. */
  spend_limit_usd: number | null;
  /** Monthly token ceiling (input + output); null = none. Same enforcement. */
  token_limit: number | null;
  /** Alert threshold as a fraction of the spend ceiling; null = no alert. */
  spend_alert_fraction: number | null;
  /** This calendar month's priced spend, what the ceiling is judged against. */
  month_spend_usd: number;
  /** This calendar month's tokens (input + output), for the token ceiling. */
  month_tokens: number;
  /** Label of the model that serves when routing has no better pick. */
  served_model: string | null;
  serving_state: ServingState;
  /** Per-model overrides keyed by candidate name; absent key = model default. */
  /** Whether reasoning modes are available at all (the create checkbox). */
  reasoning_enabled: boolean;
  model_params: ModelParamsMap;
  /** Every candidate with what it CAN take; the UI derives its controls from this. */
  model_options: ModelReasoningOption[];
};

/** One candidate model's request-modifying overrides. */
export type ModelParams = {
  /** Pinned reasoning effort, one of the candidate's reasoning_levels. */
  reasoning_effort?: string | null;
};

export type ModelParamsMap = Record<string, ModelParams>;

/** One pool candidate and the effort levels serving can honor for it. */
export type ModelReasoningOption = {
  /** Pool entry name (the stable candidate handle). */
  model: string;
  label: string;
  /** Ordered low to high; empty = the model manages its own reasoning. */
  reasoning_levels: string[];
};

export type EndpointSettingsInput = {
  store_bodies: boolean;
  paused: boolean;
  spend_limit_usd: number | null;
  token_limit: number | null;
  spend_alert_fraction: number | null;
  /** Whether reasoning modes are available at all (the create checkbox). */
  reasoning_enabled: boolean;
  model_params: ModelParamsMap;
};

/** A customer-connected OpenAI-compatible model (keyless; the backend 422s a key). */
export type LocalModelInput = {
  /** The server's base URL exactly as typed, e.g. "http://localhost:11434/v1". */
  base_url: string;
  /** The model id that server serves, e.g. "qwen3:4b". */
  model: string;
  /** Pool handle; derived from the model id when omitted. */
  name?: string;
  /** Declared $/Mtok; local inference defaults to 0. */
  input_per_mtok?: number;
  output_per_mtok?: number;
};

/** Creation inputs: an endpoint is created FROM a built world model. */
export type CreateEndpointInput = {
  name: string;
  /**
   * Optional (D-ENDPOINT-ARTIFACTS): an endpoint whose evidence comes from a real benchmark
   * rather than a world-model sweep has no simulation to link, and the API's column is nullable.
   */
  world_model_id?: string;
  /** Pool entry for the day-one static policy; server default when omitted. */
  model?: string;
  /** Catalog candidates kept in the routing pool; omitted keeps them all. */
  models?: string[];
  /** One customer-connected model appended beside the catalog selection. */
  local_model?: LocalModelInput;
  /** OpenRouter model ids to add as candidates (bill the org's OpenRouter key). */
  openrouter_models?: string[];
  /** True only for the Add-to-workspace door: clone the default, evidence included. */
  adopt_default?: boolean;
  /** Whether reasoning modes are available to this model (create checkbox). */
  include_reasoning?: boolean;
};

/** One row of the create flow's candidate checklist (GET serving-models). */
export type ServingModelChoice = ModelRef & {
  /** Pool entry name, what CreateEndpointInput.models / .model carry. */
  name: string;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  /**
   * Whether this org's own provider key can bill the candidate (the serving
   * boundary prefers the org route when one is connected). Optional so a
   * backend that predates the BYOK field still types.
   */
  org_key?: boolean;
  /**
   * False rows are part of the offered suite but cannot serve until the key
   * named by `needs` is connected. Optional (missing means serveable) so a
   * backend that predates the full-suite union still types.
   */
  available?: boolean;
  /** The provider connection that lights an unavailable row up. */
  needs?: "anthropic" | "azure_openai" | "openai" | "openrouter" | null;
  /** Set on rows served through OpenRouter; what openrouter_models carries. */
  openrouter_id?: string | null;
};

/**
 * Who pays for one candidate's calls. `detail` is a customer-facing sentence
 * fragment the backend composes ("your anthropic key (...abcd)", "platform
 * credentials", or a connected server's URL) and the UI renders verbatim
 * rather than re-deriving from the route.
 */
export type BillingRoute = {
  route: "platform" | "org_key" | "customer_server";
  detail: string;
};

/** One candidate in the endpoint's routing pool, with the traffic it took. */
export type EndpointUsageModel = ModelRef & {
  /** Pool entry name; what setModels selects by and served_model names. */
  name: string;
  /** False for historical traffic whose model left the pool. */
  in_pool: boolean;
  /** Whether the Models tab may (re)select this row: pool members always;
   * out-of-pool rows only when still serveable on a static endpoint. */
  selectable: boolean;
  billing: BillingRoute;
  request_count: number;
  /** 0..1 share of the endpoint's served requests; 0 for an idle candidate. */
  traffic_share: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

/**
 * The endpoint's lifetime serving totals. `cost_usd` covers only requests with
 * a verified price: `unpriced_count` requests are counted and excluded from it,
 * which the Usage view states rather than presenting a partial sum as complete.
 */
export type EndpointUsageTotals = {
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unpriced_count: number;
};

/**
 * One endpoint's usage read: totals, plus one row per routing-pool candidate
 * (idle candidates included, so the routable set is complete). `served_model`
 * is the static policy's served default, which is what makes a row the
 * endpoint's "Single best" and why that row cannot leave the pool.
 */
export type EndpointUsage = {
  endpoint: string;
  served_model: string | null;
  totals: EndpointUsageTotals;
  models: EndpointUsageModel[];
};

/** Edit which catalog candidates ride a static endpoint's routing pool. */
export type UpdateEndpointModelsInput = {
  /**
   * The kept candidates by pool-entry name. Connected local models stay
   * whether or not they are listed; the served default may not be dropped.
   */
  models: string[];
};

/** One OpenRouter catalog row the create flow can add as a candidate. */
export type OpenRouterModelChoice = {
  id: string;
  input_per_mtok: number;
  output_per_mtok: number;
  tier: ModelTier;
};

export type OpenRouterModelList = {
  /** Whether the org has an OpenRouter key; picks bill through it. */
  connected: boolean;
  models: OpenRouterModelChoice[];
};

export type ServingModelList = {
  models: ServingModelChoice[];
  /** The entry served when the customer makes no explicit choice. */
  default: string;
  /** Whether the org's OpenRouter key exists (drives the inline connect). */
  openrouter_connected?: boolean;
};

/**
 * The router settings a dial position resolves to. Server internals: the UI
 * never reads inside it, and it stays opaque here rather than being modeled,
 * because the shape belongs to the router and not to this product surface.
 */
export type RoutingKnobs = Readonly<Record<string, unknown>>;

/**
 * One measured point on the endpoint's cost-quality frontier. Both deltas are
 * stated against the strongest single model on the endpoint's held-out
 * benchmark, so a point can beat that reference on quality and on cost at once.
 */
export type RoutingAnchor = {
  /** The dial position this point was measured at, 0..1. */
  s: number;
  /**
   * The point's name, display-ready, e.g. "Quality max". The UI still passes it
   * through displayPointLabel, which is a no-op for these and a guard against an
   * identifier-shaped name reaching a customer. No anchor may be named "Custom":
   * that name is reserved for a position between anchors, and an anchor carrying
   * it would make a measured position indistinguishable from an interpolated one.
   */
  label: string;
  /** Quality change in percentage points; positive beats the reference. */
  quality_delta_pt: number;
  /** Cost change as a percent; negative spends less than the reference. */
  cost_delta_pct: number;
};

/**
 * The endpoint's routing dial: how far it may trade quality for spend. 0.0
 * keeps the most traffic on the strongest model, 1.0 sends the most to cheaper
 * ones.
 *
 * `cost_quality` is null on an endpoint nobody has dialed, where `named_point`
 * reads "as-fitted": serving follows the position the optimizer fitted, and the
 * dial has no customer-chosen value yet. `named_point` is otherwise the anchor
 * name the position sits exactly on, or "Custom" between anchors.
 *
 * `dialable` false means this endpoint has no frontier to move along; the UI
 * says so instead of offering a control that cannot work.
 */
export type RoutingConfig = {
  endpoint: string;
  dialable: boolean;
  /** 0..1, or null when the endpoint has never been dialed. */
  cost_quality: number | null;
  named_point: string;
  knobs: RoutingKnobs | null;
  anchors: RoutingAnchor[];
};

/** The period a savings readout covers. */
export type SavingsWindow = "all_time" | "7d";

/**
 * What serving through this endpoint has saved against always calling the
 * strongest single model. Only `requests_served` is a count: the saving figures
 * are ESTIMATES, and `estimate_basis` states how each one is derived. The UI
 * renders those lines verbatim and never presents any of this as an invoiced
 * amount.
 *
 * Savings can be NEGATIVE: an endpoint dialed toward quality may spend more than
 * the fallback would have. The UI states that plainly rather than clamping to
 * zero.
 */
export type EndpointSavings = {
  /** Requests served in the window; 0 means the endpoint has no traffic yet. */
  requests_served: number;
  /** Requests on models the customer prices at $0; excluded from the comparison. */
  zero_cost_requests: number;
  /** False while any row lacks a verified price: no saving is stated then. */
  priced_complete: boolean;
  /** Spend avoided; negative when this endpoint spent more than the fallback. */
  cost_saved_usd: number;
  /** Share of the counterfactual spend avoided, as a percent; may be negative. */
  cost_saved_pct: number;
  /**
   * Cumulative latency avoided, in seconds. Reads 0 until the endpoint has
   * enough fallback traffic to calibrate against, which is a "no claim yet"
   * state and not a claim of zero.
   */
  time_saved_s_estimate: number;
  /** Fitted expectation in percentage points, not a live measurement. */
  expected_quality_delta_pt: number;
  /** What this endpoint's own traffic actually cost. */
  actual_cost_usd: number;
  /** What that traffic is estimated to have cost on the fallback model. */
  baseline_cost_estimate_usd: number;
  /** Plain-language derivations, one line each, shown verbatim. */
  estimate_basis: string[];
  window: SavingsWindow;
};

/**
 * The Models pages' data seam. Pages consume ONLY this interface; the live
 * provider fetches the explabs serving wrapper through the web API routes.
 *
 * The routing pair maps to GET and PUT /v1/endpoints/{name}/config and the
 * savings read to GET /v1/endpoints/{name}/savings on the serving backend; the
 * org is the request's auth scope there and an explicit argument here, matching
 * the addressing the other methods use.
 *
 * A rejected WRITE's `Error.message` is shown to the customer: the cards render
 * it in their save-failed tile, because a refused write is about something they
 * just chose. A live provider must therefore translate a transport-shaped error
 * body into one readable sentence there, not pass the raw payload through as the
 * message. Two known write rejections arrive this way: an OpenAI-shaped 400 for
 * a cost_quality outside 0..1, and a 409 `dial_unavailable` when the endpoint
 * stops being dialable under a write.
 *
 * A rejected READ's message is never rendered; the cards state what happened in
 * their own copy, which can add the reassurance that matters more in that moment
 * (serving is unaffected) than a transport detail would.
 *
 * `setModels` is the second write on this seam and follows the same rule, with
 * two rejections that matter to the customer: a 409 when the endpoint's router
 * has been fitted on its current candidates (the message names retraining as
 * the way to change the set), and a 400 when the write would drop the model the
 * endpoint serves. Both are shown verbatim.
 */
/** One routing-optimizer run: what was authorized, projected, and spent. */
/**
 * The org-facing projection of an optimizer job's progress payload: an
 * allowlisted OBJECT (never a sentence), `{}` until the worker's first write.
 */
export type OptimizeProgress = {
  stage?: string;
  done?: number;
  total?: number;
  scenarios?: number;
  models?: number;
  /** Prepare-stage milestone ("staging the trace corpus"), before the first cell. */
  step?: string;
  /** How many scenarios the sweep's plan cut (the matrix's column count). */
  scenario_count?: number;
  /** Live outcome matrix: per model, which scenario ordinals (1-based) landed. */
  matrix?: Record<string, { scored?: number[]; unscored?: number[] }>;
  /** Newest-first tail of the cells that just measured, with their story. */
  recent?: {
    model?: string;
    scenario?: number;
    scored?: boolean;
    cost_usd?: number;
    /** Judge score for the episode (absent on unscored cells). */
    reward?: number;
    /** Excerpt of the scenario's task prompt (from the org's own corpus). */
    task?: string;
    /** Excerpt of the candidate's final answer. */
    reply?: string;
    /** Excerpt of the judge's critique. */
    critique?: string;
  }[];
  /** Scenario ordinal (1-based, as a string key) to task excerpt. */
  scenario_tasks?: Record<string, string>;
  /** Per-cell hover stories: model -> scenario ordinal -> what that cell did. */
  stories?: Record<
    string,
    Record<string, { scored?: boolean; cost_usd?: number; reward?: number; reply?: string }>
  >;
  /** Fit-stage per-model scored/unscored counts. */
  cells?: Record<string, { scored?: number; unscored?: number }>;
};

export type OptimizeRun = {
  job_id: string;
  status: "queued" | "claimed" | "running" | "completed" | "failed" | "stalled" | "cancelled" | "paused";
  progress: OptimizeProgress;
  spend_cap_usd: number;
  projected_usd: number | null;
  spend_usd: number | null;
  error: string | null;
};

export type EndpointProvider = {
  list(orgSlug: string): Promise<EndpointSummary[]>;
  get(orgSlug: string, name: string): Promise<Endpoint | null>;
  create(orgSlug: string, input: CreateEndpointInput): Promise<EndpointSummary>;
  getRoutingConfig(orgSlug: string, name: string): Promise<RoutingConfig>;
  setRoutingConfig(orgSlug: string, name: string, costQuality: number): Promise<RoutingConfig>;
  getSavings(orgSlug: string, name: string): Promise<EndpointSavings>;
  getUsage(orgSlug: string, name: string): Promise<EndpointUsage>;
  setModels(
    orgSlug: string,
    name: string,
    models: string[],
    servedModel?: string
  ): Promise<Endpoint>;
  /** Queue a routing-optimizer run; the ceiling is explicit, never defaulted. */
  optimize(orgSlug: string, name: string, spendCapUsd: number): Promise<OptimizeRun>;
  /** This endpoint's optimizer runs, newest first. */
  listOptimizeRuns(orgSlug: string, name: string): Promise<OptimizeRun[]>;
  /** Stop, pause, or resume one training run (the product owner, 2026-08-01). */
  controlOptimizeRun(
    orgSlug: string,
    name: string,
    runId: string,
    action: "cancel" | "pause" | "resume"
  ): Promise<void>;
};

/** Example prompts sourced from the endpoint's world-model scenarios. */
export type PlaygroundSuggestion = {
  id: string;
  title: string;
  prompt: string;
};

/** Per-response routing evidence shown in the playground inspector. */
export type RoutingInspection = {
  model: ModelRef;
  /** Task-cluster label the request was assigned to. */
  cluster: string;
  /** Null when the call has no verified price (errored or unpriced model). */
  cost_usd: number | null;
  latency_ms: number;
  /** The request's own token workload; optional so older producers still parse. */
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** What the same response would have cost on the frontier reference. */
  counterfactual_frontier_cost_usd: number;
};

/**
 * Stream events for one playground chat response: the OpenAI-compatible
 * streaming endpoint's deltas plus one routing_inspection event per
 * assistant response.
 */
export type PlaygroundStreamEvent =
  | { type: "delta"; text: string }
  | { type: "routing_inspection"; inspection: RoutingInspection }
  | { type: "done" }
  | { type: "error"; message: string };
