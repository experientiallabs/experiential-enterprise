export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// --- Organizations ---

/**
 * One organization the actor can act in, as `GET /api/orgs` returns it. The
 * organization is the workspace: world models, traces, usage, and API keys
 * all hang directly off it. `role` is the actor's membership role
 * ("platform_admin" for operators seeing every org).
 */
export type Org = {
  id: string;
  slug: string;
  name: string;
  role: string;
  /** Trigger-maintained priced spend across every metered org surface. */
  spend_usd: number;
  /** The part of spend that draws down credits (BYOK serving excluded). */
  billable_spend_usd: number;
  /** Ledger sum of grants, top-ups, and adjustments. */
  credit_granted_usd: number;
  /** granted - billable; may be negative after an overdraw. */
  credit_balance_usd: number;
  /**
   * Whether a verified domain of the org currently requires SSO (E2).
   * Enriched at the web tier from the sso_required_org_ids definer read for
   * the membership-discovery carve-out surfaces (org list, switcher tag);
   * absent on payloads that never pass through the enrichment.
   */
  sso_required?: boolean;
};

/**
 * An unexpired, unrevoked /yc launch grant on the org. Null on the budget
 * payload once the grant expires or was revoked, so surfaces key on "has an
 * active YC claim" without date math.
 */
export type YcClaimState = {
  claimed_at: string;
  expires_at: string;
  /** Unspent remainder of the $526 grant; what expiry would claw back now. */
  remaining_estimate_usd: number;
};

/** What unlocks platform-credit spending for a locked org (app_settings). */
export type SpendUnlockRequirement = "email" | "card";

/**
 * The platform-wide credit/spend-unlock knobs, managed together in the admin
 * Platform panel (public.app_settings): the welcome and YC grant amounts (in
 * micro-USD), the pre-verify spend allowance (`pre_verify_enabled` mirrors
 * `pre_verify_allowance_micro_usd > 0`), and the spend-unlock requirement mode.
 */
export type CreditGatingSettings = {
  welcome_grant_micro_usd: number;
  yc_grant_micro_usd: number;
  pre_verify_allowance_micro_usd: number;
  pre_verify_enabled: boolean;
  spend_unlock_requirement: SpendUnlockRequirement;
};

/** Lightweight organization credit state for frequently refreshed UI. */
export type OrgBudget = Pick<
  Org,
  "spend_usd" | "billable_spend_usd" | "credit_granted_usd" | "credit_balance_usd"
> & {
  yc: YcClaimState | null;
};

/** Outcome of the one-click /yc grant claim. */
export type YcClaimResult = {
  granted_usd: number;
  expires_at: string;
  balance_usd: number;
};

/** One append-only credit history row (grants, top-ups, adjustments). */
export type CreditLedgerEntry = {
  id: string;
  entry_type: "grant" | "topup" | "adjustment";
  amount_usd: number;
  reason: string | null;
  source: "signup_promo" | "migration" | "admin" | "stripe" | "yc_launch";
  created_at: string;
};

// --- World models ---

export type WorldModelStatus = "created" | "building" | "ready" | "failed";

// Build-quality metrics persisted by the build worker (BuildMetrics shape).
// held_out_accuracy is the open-loop fidelity of the serving prompt over the
// held-out trace split; it is null — never a fake 0 — when no evaluation
// produced it (eval opted out or failed; eval_error then carries the detail).
export type WorldModelMetrics = {
  held_out_accuracy: number | null;
  rollouts_used: number | null;
  judge_agreement: number | null;
  /**
   * Raw spread (population std) of per-step fidelity scores; an internal
   * diagnostic — never render it as an error bar.
   */
  held_out_std?: number | null;
  /**
   * 95% CI half-width of the mean fidelity (1.96 * std / sqrt(steps)); the
   * number to show after a ±. Null when fewer than two steps were evaluated.
   */
  held_out_ci95?: number | null;
  /** Held-out steps replayed by the post-build eval. */
  evaluated_steps?: number | null;
  /** Loud failure detail when the eval produced nothing (build still ready). */
  eval_error?: string | null;
};

// Bundle metadata embedded in the detail payload once a model has a built
// bundle in object storage (world_models.artifact_id -> public.artifacts).
export type WorldModelArtifact = {
  byte_size: number;
  sha256: string;
  created_at: string;
};

// Slim projection served by the models list endpoint: everything the list
// renders except the unbounded config/metrics blobs and the artifact block.
export type WorldModelSummary = {
  id: string;
  org_id: string;
  name: string;
  display_name: string | null;
  status: WorldModelStatus;
  serve_provider: string;
  serve_model: string;
  embed_provider: string | null;
  embed_dim: number | null;
  gepa_budget: number | null;
  trace_adapter: string;
  artifact_id: string | null;
  /** Shared catalog entry the model was imported from; null for built models. */
  catalog_entry_id: string | null;
  /**
   * Stored trace-connection kind feeding this simulation (postgres, langfuse,
   * ...), or null when it runs on a static uploaded dataset. Drives the
   * Connected/Dataset state in the UI.
   */
  connected_source: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

// Full record served by the detail endpoint.
export type WorldModel = WorldModelSummary & {
  config: JsonObject;
  metrics: WorldModelMetrics | null;
  artifact: WorldModelArtifact | null;
};

export type CreateWorldModelInput = {
  name: string;
  display_name?: string;
  // Optional: when omitted, the backend derives the simulator from the
  // deployment's configured credentials (see explabs.engine.serve_defaults).
  serve_provider?: string;
  serve_model?: string;
  embed_provider?: string;
  embed_dim?: number;
  gepa_budget?: number;
};

// --- World-model catalog ---

/**
 * One shared-catalog entry: an immutable snapshot of a ready world model that
 * any organization can import. `metrics` is the source build's metrics snapshot;
 * `trace_count`/`step_count` are the replay-buffer corpus size (null when the
 * source upload never recorded them); `import_count`/`like_count`/`liked_by_me`
 * are the social counters (the list arrives most-imported first, ties newest
 * first); `available`/`unavailable_reason` are display-only serve-credential
 * guidance (missing env var names, never values) and never gate an import.
 */
export type CatalogEntry = {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  serve_provider: string;
  serve_model: string;
  embed_provider: string | null;
  embed_dim: number | null;
  trace_adapter: string;
  metrics: WorldModelMetrics | null;
  trace_count: number | null;
  step_count: number | null;
  byte_size: number;
  sha256: string;
  import_count: number;
  like_count: number;
  liked_by_me: boolean;
  /** Entry carries its trace corpus: imports start with a ready trace upload. */
  has_traces: boolean;
  created_at: string;
  deprecated_at: string | null;
  available: boolean;
  unavailable_reason: string | null;
};

export type ImportWorldModelInput = {
  catalog_entry_id: string;
  name?: string;
};

// --- Trace uploads ---

export type TraceUploadStatus = "uploaded" | "ingested" | "failed";

export type TraceUpload = {
  id: string;
  org_id: string;
  world_model_id: string | null;
  filename: string;
  storage_path: string;
  byte_size: number;
  sha256: string;
  adapter: string;
  trace_count: number | null;
  step_count: number | null;
  status: TraceUploadStatus;
  created_at: string;
};

// --- Serving telemetry ---

export type ServingWindow = "24h" | "7d" | "30d";

// --- Gateway usage (the Telemetry page's data source) ---
//
// Mirrors the response models in explabs/api/routes/gateway_usage.py — the
// tenant read surface over the gateway's per-request usage ledger. Money is
// SPLIT everywhere: `cost_usd` is CHARGED platform credits only and
// `estimated_cost_usd` is the attributed, never-charged pass-through
// estimate. "All spend" is the two added together, but the split must stay
// visible so an estimate can never read as billed money.

/**
 * Money lane: "platform" = platform credits at provider cost, "byok" = the
 * customer's own provider key (attributed, never charged). Null on rows and
 * buckets means nothing was dispatched.
 */
export type UsageLane = "platform" | "byok";

/** Terminal state of a finished gateway request. */
export type GatewayRequestStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete"
  | "expired_before_dispatch"
  | "unknown_after_crash";

/**
 * One (time bucket, model, lane) cell of the org's gateway usage.
 * `request_count` counts every finished request, errors included;
 * `error_count` is the subset whose terminal state was not `completed`.
 */
export type UsageBucket = {
  bucket_start: string;
  model: string;
  lane: UsageLane | null;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  estimated_cost_usd: number;
};

export type UsageTimeseries = {
  window: ServingWindow;
  bucket_seconds: number;
  buckets: UsageBucket[];
};

/** One model's share of an API key's traffic in the window. */
export type KeyModelUsage = {
  model: string;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  estimated_cost_usd: number;
};

export type KeyUsageTotals = {
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  estimated_cost_usd: number;
};

/**
 * One API key's ("agent's") usage rollup. `api_key_id` is null only when the
 * key was hard-deleted before the request settled; `key_label` is null (with
 * an id) when the key was deleted after settlement — history never disappears
 * with the key.
 */
export type KeyUsage = {
  api_key_id: string | null;
  key_label: string | null;
  models: KeyModelUsage[];
  totals: KeyUsageTotals;
  last_used_at: string;
};

export type UsageByKey = {
  window: ServingWindow;
  keys: KeyUsage[];
};

/**
 * One provider's ("platform's") usage rollup. `provider` is the winning
 * attempt's provider; null groups the requests where nothing was dispatched.
 */
export type ProviderUsage = {
  provider: string | null;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  estimated_cost_usd: number;
  last_used_at: string;
};

export type UsageByProvider = {
  window: ServingWindow;
  providers: ProviderUsage[];
};

/**
 * One gateway request in the Telemetry request log. This is the COMPLETE
 * tenant-visible record — the ledger is content-free (bodies are never
 * persisted), so there is no row-expand detail behind it.
 */
export type UsageRequestItem = {
  request_id: string;
  model: string;
  provider: string | null;
  lane: UsageLane | null;
  api_key_id: string | null;
  key_label: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  /** Charged platform credits only (0 for pure-BYOK requests). */
  cost_usd: number;
  /** Attributed, never-charged pass-through (BYOK) estimate. */
  estimated_cost_usd: number;
  /**
   * The always-real per-call cost: charged credits plus the never-charged BYOK
   * estimate. A BYOK row shows its real spend here instead of a $0 charge. When
   * `pricing_known` is false a 0 here means "unpriced", not "free".
   */
  real_cost_usd: number;
  /** False when the winning attempt dispatched under an unknown price. */
  pricing_known: boolean;
  latency_ms: number | null;
  /**
   * Time to first token: winning attempt dispatch -> first streamed token, ms.
   * Null when no first token was observed (non-streaming settlement,
   * pre-dispatch failure, or a row settled before TTFT capture shipped).
   */
  ttft_ms: number | null;
  status: GatewayRequestStatus;
  attempt_count: number;
  created_at: string;
  /**
   * Distinct tool names the request invoked, names only (never arguments).
   * Empty when no tool activity was captured — the honest empty state, and
   * the current state everywhere because the WMO runtime does not yet
   * surface tool names.
   */
  tools_used: string[];
  /**
   * The sanitized outcome reason for a non-`completed` request: the WMO failure
   * class and a human-readable message (names/reasons only, never content).
   * Both null for a completed/incomplete request — the status IS the outcome.
   */
  failure_class: string | null;
  error_message: string | null;
  /**
   * Content-free lineage handles (short digests, never content): requests
   * sharing `prompt_group` resent the same system prompt and tool
   * definitions; sharing `conversation_group` they belong to one
   * conversation. Null for rows settled before lineage existed.
   */
  prompt_group: string | null;
  conversation_group: string | null;
};

/**
 * One repeated-prompt group's usage rollup on one model, from
 * `GET /api/orgs/{orgId}/usage/by-prompt`. Every request in the group resent
 * the same system prompt and tool declarations; `stable_prefix_tokens_estimate`
 * derives from the prefix's character length and is an estimate, labeled as
 * such wherever it renders.
 */
export type PromptGroupUsage = {
  prompt_group: string;
  model: string;
  request_count: number;
  error_count: number;
  conversation_count: number;
  agent_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
  estimated_cost_usd: number;
  stable_prefix_tokens_estimate: number;
  last_used_at: string;
  /**
   * The captured system-prompt snippet labeling this group; null for orgs
   * without the prompt-capture opt-in (the digest handle renders instead).
   */
  prompt_snippet: string | null;
};

/**
 * One request's captured prompt (`GET .../usage/requests/{id}/prompt`).
 * Exists only for orgs that opted into prompt capture and only within the
 * capture retention window; otherwise the endpoint is a 404.
 */
export type CapturedPrompt = {
  request_id: string;
  messages: { role: string; content?: string | null }[];
  captured_at: string;
};

export type UsageByPrompt = {
  window: ServingWindow;
  prompts: PromptGroupUsage[];
};

/** The org's telemetry privacy settings (mirrors gateway_usage.py). */
export type TelemetrySettings = {
  /**
   * Opt-in to ALSO capture request/response content in telemetry. Default
   * false: the content-free metadata stream is always captured; only this flag
   * authorizes storing message content.
   */
  capture_prompt_content: boolean;
};

/** Keyset cursor for the next request-log page; echo the fields verbatim. */
export type UsageRequestsCursor = {
  ts: string;
  id: string;
  /** The first page's frozen window lower bound; echoed on later pages. */
  after: string;
};

export type UsageRequestsPage = {
  requests: UsageRequestItem[];
  next_cursor: UsageRequestsCursor | null;
};

export type ServingRequestStatus = "ok" | "error";

/** One serving-log row as the list API returns it: no bodies, no routing. */
export type ServingRequest = {
  id: string;
  endpoint_id: string;
  endpoint_label: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number | null;
  frontier_cost_usd: number;
  latency_ms: number | null;
  ttfb_ms: number | null;
  status: ServingRequestStatus;
  error_message: string | null;
  created_at: string;
};

export type ServingRequestCursor = {
  ts: string;
  id: string;
  /** The first page's frozen window lower bound; echoed on later pages. */
  after: string;
};

export type ServingRequestPage = {
  requests: ServingRequest[];
  next_cursor: ServingRequestCursor | null;
};

/** The single-row fetch adds the stored request/response bodies. */
export type ServingRequestDetail = ServingRequest & {
  org_id: string;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
};

export type ServingStats = {
  request_count: number;
  error_count: number;
  /** Requests with no verified price: the spend total does not cover them. */
  unpriced_count: number;
  cost_usd_total: number | null;
  input_tokens_total: number;
  output_tokens_total: number;
  cached_tokens_total: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
};

export type ServingBucket = {
  bucket_start: string;
  request_count: number;
  error_count: number;
};

export type ServingEndpoint = {
  endpoint_id: string;
  endpoint_label: string;
  request_count: number;
  last_at: string;
};

export type ServingSummary = {
  window: ServingWindow;
  bucket_seconds: number;
  stats: ServingStats;
  buckets: ServingBucket[];
  endpoints: ServingEndpoint[];
};

// --- Scenario sets (the mined eval-scenario artifact, generate leg of the triple) ---

/** One mined eval scenario inside a set's payload. */
export type EvalScenario = {
  scenario_id: string;
  /** Self-contained task statement handed to a candidate model. */
  task: string;
  /** Judgeable success criteria the verifier grades against. */
  checklist: string[];
  /** Source trace ids this scenario was distilled from. */
  provenance: string[];
  cluster_name: string;
  /** Fraction of the corpus this scenario represents. */
  weight: number;
  /** Outcome of the source trajectory: "success" | "failure" | "unknown". */
  source_outcome: string;
};

/**
 * A world model's live eval-scenario set (newest mined row). The
 * selection-honesty fields exist so a corpus-inverting selection is visible:
 * budget vs survivors, and the minted set's source-outcome mix.
 */
export type ScenarioSet = {
  id: string;
  world_model_id: string;
  build_job_id: string;
  payload: {
    scenarios: EvalScenario[];
    clusters?: unknown[];
    /**
     * Per-scenario split band of its source traces under the build's own
     * deterministic split ("train" | "val" | "test" | "mixed"). Consumers fit
     * on train/val-derived scenarios and report on test-derived ones.
     */
    provenance_splits?: Record<string, string>;
  };
  scenario_count: number;
  budget: number;
  dropped_count: number;
  outcome_mix: Record<string, number>;
  corpus_traces: number;
  /** Fraction of corpus facets within coverage_tau of a selected one. */
  corpus_coverage: number;
  coverage_tau: number;
  provider: string;
  model: string;
  created_at: string;
};

// --- Build jobs ---

export type BuildJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "stalled"
  | "cancelled"
  | "paused";

export type BuildProgress = {
  phase?: string;
  activity?: string;
  traces?: number;
  steps?: number;
  train?: number;
  test?: number;
  rollouts_done?: number;
  rollouts_budget?: number;
  last_score?: number;
  held_out_accuracy?: number;
  frontier_size?: number;
  /** Background held-out eval (phase "evaluating"): steps scored so far. */
  eval_done?: number;
  /** Background held-out eval: total held-out steps being scored. */
  eval_total?: number;
  /** Post-build scenario mining failed; the build itself still completed. */
  scenario_error?: string;
};

export type BuildJob = {
  id: string;
  world_model_id: string;
  trace_upload_id: string;
  status: BuildJobStatus;
  /** Pending stop/pause request the worker has not honored yet. */
  control?: string | null;
  gepa_budget: number | null;
  /** Post-build held-out fidelity evaluation (on by default). */
  evaluate: boolean;
  runtime_backend: string | null;
  runtime_call_id: string | null;
  worker_id: string | null;
  heartbeat_at: string | null;
  progress: BuildProgress;
  usage: JsonObject | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type StartBuildInput = {
  trace_upload_id: string;
  gepa_budget?: number;
  /** Post-build held-out evaluation; the backend defaults an omitted value to on. */
  evaluate?: boolean;
};

// --- Metrics rollup ---

export type WorldModelMetricsReport = {
  metrics: WorldModelMetrics | null;
  /**
   * Playground-session (rollout) rollup across the model's full history.
   * `cost_usd` is null when no rollout carries a verified price.
   */
  sessions: {
    count: number;
    forks: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    /** Rollouts whose worker leg has token traffic but no verified price. */
    unpriced: number;
    wm_input_tokens: number;
    wm_output_tokens: number;
    wm_cost_usd: number | null;
    /** Rollouts whose world-model leg has token traffic but no verified price. */
    wm_unpriced: number;
  };
  /**
   * Serving-session (`wm_sessions`) rollup — the world model's own spend.
   * `cost_usd` sums only priced sessions; sessions with token traffic but no
   * verified serve price are counted in `unpriced_sessions` instead of
   * appearing as $0.
   */
  serving: {
    count: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    unpriced_sessions: number;
  };
};

// --- Org usage ---

/**
 * The counters-only usage read: `credit` carries the enforcement counters, so
 * "remaining" on the billing surface is the same figure the 402 gate reads.
 * The old per-model and per-endpoint breakdowns were deleted with the legacy
 * usage views; usage-by-model lives on the telemetry surfaces.
 */
export type OrgUsageReport = {
  credit: OrgBudget;
};

/**
 * Every organization's priced spend next to its budget, computed by the
 * backend in one pass for the admin Organizations panel.
 */
export type PlatformOrgUsageReport = {
  orgs: Array<{
    org_id: string;
    spend_usd: number;
    billable_spend_usd: number;
    credit_granted_usd: number;
    credit_balance_usd: number;
    /** When set, an admin lifted the org's free-credit daily caps. */
    free_credit_caps_lifted_at: string | null;
    /** Platform-funded gateway attempts billed $0 for an unknown cost (review signal). */
    gateway_unknown_cost_attempts: number;
  }>;
};

export type WmAction =
  | { kind: "tool_call"; name: string; arguments?: JsonObject }
  | { kind: "message"; content: string };

/** One recorded (action, observation) pair from an uploaded corpus. */
export type TraceEpisodeStep = {
  /** Human-readable action line (tool(name/arguments) or message content). */
  action: string | null;
  /** The structured recorded action preserved with the trace corpus. */
  replay_action: WmAction | null;
  observation: string | null;
};

/** One recorded episode, parsed by the model's trace adapter. */
export type TraceEpisode = {
  trace_id: string;
  task: string | null;
  step_count: number;
  steps: TraceEpisodeStep[];
};

export type TraceEpisodesPage = {
  episodes: TraceEpisode[];
  total_traces: number;
};

/** One mined scenario as a 2D point in the retrieval embedding space. */
export type ScenarioMapPoint = {
  scenario_id: string | null;
  task: string;
  cluster: string;
  outcome: string | null;
  weight: number | null;
  x: number;
  y: number;
};

export type ScenarioMap = {
  points: ScenarioMapPoint[];
};

/** The linked simulation's build metrics and corpus size, or honest nulls. */
export type ProjectFidelity = {
  metrics: Record<string, unknown> | null;
  corpus: {
    trace_count: number;
    step_count: number;
    upload_count: number;
  } | null;
};

/** One dataset corpus row: an acquired Project source or a retained upload. */
export type ProjectDatasetSource = TraceUpload & {
  source: "project" | "simulation";
};

// --- Usage ---

export type UsageTotals = {
  calls?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
};

/**
 * wmh RunRecord-shaped usage summary. `by_phase` keys are engine phase names;
 * the whole payload can be empty for sessions that never persisted usage.
 */
export type UsageSummary = {
  total?: UsageTotals;
  duration_seconds?: number;
  by_phase?: Record<string, UsageTotals>;
} & JsonObject;

/**
 * Vocabulary of the suggestions contract. Mirrors the backend's
 * SuggestionKind enum (explabs/api/suggestions.py); the two widen together.
 */
export type SuggestionKind = "cheaper_model" | "caching" | "latency" | "quality";

/**
 * One suggestion from `GET /api/orgs/{orgId}/suggestions`. `evidence` lines
 * are plain language and render verbatim. `estimated_monthly_savings_usd` is
 * a decimal string — an estimate from the org's own usage, never an invoiced
 * amount, never clamped — or null when the suggestion has no dollar figure.
 */
export type Suggestion = {
  id: string;
  kind: SuggestionKind;
  title: string;
  body: string;
  estimated_monthly_savings_usd: string | null;
  evidence: string[];
};

export type Suggestions = {
  suggestions: Suggestion[];
};

// --- Insights natural-language query (the Insights surface) ---
//
// Mirrors explabs/api/insights_query.py. A plain-language question is parsed
// server-side into a typed (metric, dimension, window) query and answered from
// the org's OWN usage aggregates — there is no free-form query path.

export type InsightMetric = "spend" | "requests" | "errors" | "tokens";
export type InsightDimension = "model" | "provider" | "lane" | "agent" | "total";
export type InsightUnit = "usd" | "count" | "percent";

/** One ranked row of an answer; `value` is already in the answer's unit. */
export type InsightAnswerRow = {
  label: string;
  value: number;
  detail: string | null;
};

/**
 * The answer to a usage question. `understood` is false only when the question
 * named no metric at all — that answer carries `examples` instead of `rows`.
 * An understood question with no matching usage is still understood, with empty
 * `rows` and a headline that says there is nothing yet.
 */
export type InsightAnswer = {
  understood: boolean;
  interpretation: string;
  headline: string;
  metric: InsightMetric | null;
  dimension: InsightDimension | null;
  window: ServingWindow | null;
  unit: InsightUnit | null;
  rows: InsightAnswerRow[];
  caveat: string | null;
  examples: string[];
};

// --- Imported historical spend (the Telemetry "Imported" section) ---
//
// Mirrors explabs/api/routes/usage_import.py. Attribution only: spend the
// tenant already paid their provider (imported from local Codex / Claude Code
// logs by the onboarding step-5 import), shown so the usage view is complete
// from day one. It is never charged here and never deducted from credits.

export type ImportSource = "codex" | "claude-code";

export type ImportedModelSpend = {
  source: ImportSource;
  model: string;
  model_matched: boolean;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
};

export type ImportedUsageTotals = {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type ImportedUsage = {
  models: ImportedModelSpend[];
  totals: ImportedUsageTotals;
};
