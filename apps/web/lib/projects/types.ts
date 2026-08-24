export type Project = {
  id: string;
  org_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  /** The simulation this Project optimizes against; null until linked. */
  world_model_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectList = {
  projects: Project[];
  total: number;
  limit: number;
  offset: number;
};

export type ProjectListQuery = {
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

export type CreateProjectInput = {
  slug: string;
  display_name: string;
  description?: string | null;
};

export type ProjectTraceFormat =
  | "braintrust"
  | "chat-json"
  | "langfuse"
  | "langsmith"
  | "mastra"
  | "otel-genai"
  | "otlp"
  | "phoenix"
  | "posthog";

export type ProjectTraceTransport =
  | "braintrust"
  | "langfuse"
  | "langsmith"
  | "mastra"
  | "posthog"
  | "postgres";

export type ProjectTraceConnection = {
  transport_kind: ProjectTraceTransport;
};

export type ProjectTraceConnectionList = {
  connections: ProjectTraceConnection[];
};

export type ProjectTraceSource = {
  id: string;
  project_id: string;
  source_kind: ProjectTraceFormat;
  source_label: string;
  sha256: string;
  byte_size: number;
  content_type: string;
  record_count_estimate: number;
  acquired_at: string;
  created_at: string;
};

export type ProjectTraceAcquisition = {
  id: string;
  project_id: string;
  source_kind: ProjectTraceFormat;
  transport_kind: ProjectTraceTransport | "upload";
  source_label: string;
  state: "pending" | "acquiring" | "succeeded" | "failed";
  attempt_count: number;
  cursor_state: "start" | "checkpointed" | "complete";
  records_acquired: number;
  max_records: number | null;
  since_at: string | null;
  byte_size: number | null;
  error_code: string | null;
  source_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectTraceUploadResult = {
  acquisition: ProjectTraceAcquisition;
  source: ProjectTraceSource | null;
};

export type ProjectRemoteTraceAcquisitionInput = {
  source_kind: ProjectTraceFormat;
  transport_kind: ProjectTraceTransport;
  source_label: string;
  since_at?: string;
  max_records?: number;
  postgres_query?: {
    table: string;
    payload_column: string;
    order_column?: string;
  };
};

export type ProjectCredentialSource = "byok" | "platform";
export type ProjectLaunchProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "azure_openai"
  | "openrouter"
  | "bedrock"
  | "local";

/**
 * Explicit capability and price declaration for providers WMO cannot
 * discover offline (Azure, OpenRouter, Bedrock, and local servers).
 */
export type ProjectModelMetadata = {
  supports_completions?: boolean | null;
  supports_embeddings?: boolean | null;
  supports_tools?: boolean | null;
  context_window_tokens?: number | null;
  maximum_output_tokens?: number | null;
  input_cost_per_million_tokens_usd?: number | null;
  output_cost_per_million_tokens_usd?: number | null;
};

export type ProjectModelChoice = {
  alias: string;
  model: string;
  provider: ProjectLaunchProvider;
  credential_source: ProjectCredentialSource;
  connection_alias: string | null;
  /** A customer-run OpenAI-compatible server; local models only. */
  base_url: string | null;
  metadata: ProjectModelMetadata | null;
  credential_status:
    | "byok_active"
    | "byok_missing"
    | "platform_available"
    | "platform_unavailable"
    | "local";
};

export type ProjectModelChoiceInput = Omit<ProjectModelChoice, "credential_status">;

export type ProjectModelRoles = {
  world_model: ProjectModelChoice | null;
  judge: ProjectModelChoice | null;
  embedder: ProjectModelChoice | null;
  baseline: ProjectModelChoice | null;
  candidates: ProjectModelChoice[];
};

export type ProjectModelRolesInput = {
  world_model: ProjectModelChoiceInput | null;
  judge: ProjectModelChoiceInput | null;
  embedder: ProjectModelChoiceInput | null;
  baseline: ProjectModelChoiceInput | null;
  candidates: ProjectModelChoiceInput[];
};

export type ProjectProviderConnection = {
  provider: ProjectLaunchProvider;
  connection_alias: string | null;
  display_name: string;
  status: "active" | "missing";
};

export type ProjectPlatformModel = {
  provider: ProjectLaunchProvider;
  model: string;
  display_name: string;
};

export type ProjectSetup = {
  project_id: string;
  version: number;
  system: {
    kind: "builtin_chat";
    system_prompt: string;
    maximum_model_calls: number;
  } | null;
  models: ProjectModelRoles;
  run_budget_usd: string | null;
  execution: { max_parallel_requests: number } | null;
  available_connections: ProjectProviderConnection[];
  available_platform_models: ProjectPlatformModel[];
  setup_ready: boolean;
  readiness_reasons: string[];
  updated_at: string | null;
};

export type ProjectSetupInput = {
  expected_version: number;
  system: {
    kind: "builtin_chat";
    system_prompt: string;
    maximum_model_calls: number;
  } | null;
  models: ProjectModelRolesInput;
  run_budget_usd: string | null;
  execution: { max_parallel_requests: number } | null;
};

export type ProjectJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "ambiguous";

export type ProjectJob = {
  id: string;
  project_id: string;
  operation: "preparation" | "optimization";
  status: ProjectJobStatus;
  stage: string | null;
  domain_stage: string | null;
  progress: {
    message: string;
    completed_units: number | null;
    total_units: number | null;
  };
  spend_usd: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    action: string;
  } | null;
  attempt_count: number;
  last_event_seq: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectPreparation = {
  state: "not_started" | "queued" | "preparing" | "ready" | "failed" | "superseded";
  job: ProjectJob | null;
  prepared_at: string | null;
};

export type ProjectJobEvent = {
  seq: number;
  event_type: string;
  stage: string | null;
  domain_stage: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ProjectMetricEstimate = {
  point: number | null;
  ci95_lower: number | null;
  ci95_upper: number | null;
  measured_task_count: number;
  missing_task_count: number;
};

export type ProjectResult = {
  project_id: string;
  model: string;
  router_id: string | null;
  active_generation: number | null;
  active: boolean;
  archived: boolean;
  activated_at: string | null;
  current_job_active: boolean;
  completed_at: string | null;
  report: {
    held_out_task_count: number;
    routed: {
      score: ProjectMetricEstimate;
      candidate_cost_usd: ProjectMetricEstimate;
      candidate_latency_seconds: ProjectMetricEstimate;
    };
    baseline: {
      score: ProjectMetricEstimate;
      candidate_cost_usd: ProjectMetricEstimate;
      candidate_latency_seconds: ProjectMetricEstimate;
    };
    paired_quality: {
      compared_task_count: number;
      excluded_task_count: number;
      routed_weighted_score: number | null;
      baseline_weighted_score: number | null;
      weighted_difference: number | null;
      difference_ci95_lower: number | null;
      difference_ci95_upper: number | null;
    };
    fallback_count: number;
    fallback_rate: number;
    coverage: Record<string, number>;
  } | null;
  build_spend: {
    ceiling_usd: string;
    total_usd: string;
    host_managed_usd: string;
    customer_managed_usd: string;
    outcome: "completed" | "failed_closed";
    restart: "completed_stage_bundle" | "blocked_ambiguous_operation";
    components: {
      component: string;
      operation_count: number;
      amount_usd: string;
      statuses: string[];
      billing_source: "host_managed" | "customer_managed";
    }[];
  } | null;
};

export type ProjectServingSettings = {
  project_id: string;
  paused: boolean;
  store_bodies: boolean;
  spend_limit_usd: string | null;
  token_limit: number | null;
  spend_alert_fraction: string | null;
  updated_at: string;
};

export type ProjectServingSettingsInput = Omit<
  ProjectServingSettings,
  "project_id" | "updated_at"
> & { expected_updated_at: string };

export type ProjectServingUsage = {
  project_id: string;
  period_start: string;
  period_end: string;
  spend_used_usd: string;
  tokens_used: string;
  request_count: string;
  spend_limit_usd: string | null;
  token_limit: number | null;
  spend_alert_fraction: string | null;
  spend_alert_triggered: boolean;
  spend_limit_exhausted: boolean;
  token_limit_exhausted: boolean;
};

export type ProjectDetailSnapshot = {
  project: Project;
  traceSource: ProjectTraceSource | null;
  traceConnections: ProjectTraceConnection[];
  traceAcquisition: ProjectTraceAcquisition | null;
  preparation: ProjectPreparation;
  setup: ProjectSetup;
  currentJob: ProjectJob | null;
  result: ProjectResult;
  servingSettings: ProjectServingSettings;
  usage: ProjectServingUsage;
};

export const ACTIVE_PROJECT_JOB_STATUSES: ReadonlySet<ProjectJobStatus> = new Set([
  "queued",
  "claimed",
  "running"
]);
