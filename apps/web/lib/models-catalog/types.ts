// TypeScript mirrors of the gateway models management API's response views
// (explabs/api/routes/models_catalog.py — ModelView / DeploymentView /
// WaterfallRungView and their envelopes). The Python views are the contract;
// these types restate them field-for-field so every catalog surface reads one
// vocabulary. Prices are integer micro-USD per million tokens; null means
// unknown and must never render as $0 (lib/money.ts owns the display).

export type CatalogProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "azure_openai"
  | "openrouter"
  | "bedrock"
  | "local"
  | "fireworks"
  | "modal"
  | "experiential_cloud";

export type CatalogModel = {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  /** Lowercase model-family key for the logo; null renders the letter mark. */
  icon: string | null;
  release_date: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  input_modalities: string[];
  output_modalities: string[];
  supported_params: Record<string, unknown>;
  category: string | null;
  tags: string[];
  owning_org_id: string | null;
  preferred_rank: number | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type CatalogDeployment = {
  id: string;
  model_id: string;
  provider: CatalogProvider;
  provider_model_id: string;
  base_url: string | null;
  region: string | null;
  api_version: string | null;
  owning_org_id: string | null;
  provider_connection_id: string | null;
  /**
   * Which lane funds this route (mirrors model_providers.billing_source):
   * `host_managed` = platform-funded, usable through Experiential credits;
   * `customer_managed` = BYOK, the caller funds it with their own provider key.
   * See lib/models-catalog/serving.ts for the "served through Experiential" rule.
   */
  billing_source: "host_managed" | "customer_managed";
  input_micro_usd_per_million: number | null;
  cached_input_micro_usd_per_million: number | null;
  output_micro_usd_per_million: number | null;
  reasoning_micro_usd_per_million: number | null;
  pricing_source: string | null;
  pricing_effective_at: string | null;
  capabilities: Record<string, unknown>;
  uptime_30d: number | null;
  throughput_tps: number | null;
  latency_p50_ms: number | null;
  stats_source: "openrouter" | "observed" | "estimate" | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type CatalogEntry = {
  model: CatalogModel;
  providers: CatalogDeployment[];
};

/**
 * One promotional listing (mirrors PromotionView). The authoritative promo set
 * + caps live in public.model_promotions (owned by the promo-caps workstream);
 * the catalog reads only the display fields. `slugs` arrives resolved and
 * visibility-filtered server-side (family and provider scopes already expanded
 * to concrete models). A promoted model appears BOTH in the catalog's
 * Promotional section (ordered by display_order) AND under its normal family
 * section — distinct from preferred_rank ("Recommended").
 */
export type ModelPromotion = {
  label: string;
  slugs: string[];
  display_order: number;
  /** Models in this promo are free up to a per-org allowance ("FREE" badge). */
  free: boolean;
  /**
   * Credit-spend discount, 0-100. When `providers` is non-empty the discount
   * only applies to requests served through those lanes; the chip's visible
   * copy stays bare ("50% off") and the lane restriction rides its hover
   * title and aria-label instead.
   */
  percent_off: number;
  providers: string[];
  family_keys: string[];
};

export type ModelList = {
  models: CatalogEntry[];
  promotions: ModelPromotion[];
  total: number;
  limit: number;
  offset: number;
};

export type WaterfallRung = {
  id: string;
  position: number;
  model_provider_id: string;
  provider: CatalogProvider;
  provider_model_id: string;
  base_url: string | null;
  status: string;
};

/**
 * One public benchmark score (mirrors ModelBenchmarkView). Display metadata
 * (name, unit, direction) is joined server-side from the code registry;
 * `source`/`source_url`/`retrieved_at` are the provenance the UI must show
 * next to the number (house rule: numbers never render without their source).
 */
export type ModelBenchmark = {
  benchmark: string;
  display_name: string;
  unit: "percent" | "elo" | "points";
  higher_is_better: boolean;
  score: number;
  source: string;
  source_url: string | null;
  retrieved_at: string;
};

export type ModelDetail = {
  model: CatalogModel;
  providers: CatalogDeployment[];
  default_waterfall: WaterfallRung[];
  /** Open-weights repo on Hugging Face; null for closed models. */
  huggingface_url: string | null;
  /** Official vendor release/announcement page; the link when no HF repo exists. */
  release_url: string | null;
  /** Detail-only (the list payload stays lean); registry order, then unknown slugs. */
  benchmarks: ModelBenchmark[];
};

export type Waterfall = {
  model_id: string;
  slug: string;
  org_id: string | null;
  default: WaterfallRung[];
  override: WaterfallRung[] | null;
};

/** Create payload for POST /api/models (the add-custom-model form). */
export type ModelCreateInput = {
  org_id: string;
  slug: string;
  display_name: string;
  description?: string;
  release_date?: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities: string[];
  output_modalities: string[];
  supported_params: Record<string, boolean>;
  providers: DeploymentCreateInput[];
};

/** Create payload for POST /api/models/{slug}/providers (local variants). */
export type DeploymentCreateInput = {
  org_id?: string;
  provider: CatalogProvider;
  provider_model_id: string;
  base_url?: string;
  provider_connection_id?: string;
  input_micro_usd_per_million?: number;
  cached_input_micro_usd_per_million?: number;
  output_micro_usd_per_million?: number;
  reasoning_micro_usd_per_million?: number;
  pricing_source?: string;
  /**
   * GatewayDeploymentCapabilities the backend gates on (absent = false). The
   * local-model path sets `supports_streaming: true` because WMO forces
   * stream=true on every dispatch and preflights it (int-p3). Consumed by
   * store.createLocalModel.
   */
  capabilities?: Record<string, boolean>;
};
