// The model providers an org can connect its own account to (BYOK). Sibling of
// lib/trace-ingest.ts: that namespace names TRACE SOURCES, these name the
// inference accounts serving and optimization bill against, and they are stored
// in a different table (provider_connections) behind their own service-role
// RPCs. Shared by the settings panel that writes them and the API route that
// validates the write.

export const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "azure_openai",
  "openrouter",
  "bedrock",
  "fireworks",
  "modal"
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

// The customer-facing product NAMES. The backend enum key stays `azure_openai`
// (the wire protocol is the Azure-OpenAI-compatible API), but the product is
// Azure AI Foundry, so every surface that shows a name renders "Azure Foundry".
const PROVIDER_LABELS: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  azure_openai: "Azure Foundry",
  openrouter: "OpenRouter",
  bedrock: "Amazon Bedrock",
  fireworks: "Fireworks AI",
  modal: "Modal"
};

/**
 * The canonical key-level connection states, exactly the backend's enum. Any
 * surface rendering key state uses these strings. "Model not deployed" is
 * deliberately NOT a status: the key stays valid and the per-model fact rides
 * status_detail.models.
 */
export const PROVIDER_CONNECTION_STATUSES = [
  "unchecked",
  "valid",
  "invalid",
  "rate_limited",
  "quota_exhausted",
  "provider_error"
] as const;

export type ProviderConnectionStatus = (typeof PROVIDER_CONNECTION_STATUSES)[number];

export function isProviderConnectionStatus(value: string): value is ProviderConnectionStatus {
  return (PROVIDER_CONNECTION_STATUSES as readonly string[]).includes(value);
}

/**
 * One hookup-check verdict, as the backend's check endpoint returns it and as
 * the connect/rotate PUT relays it: the canonical status plus the verbose
 * provider detail (raw code, raw message, our remediation text). Never a key.
 */
export type ProviderConnectionCheck = {
  provider: string;
  status: ProviderConnectionStatus;
  status_detail: Record<string, unknown> | null;
  status_checked_at: string | null;
  status_source: "hookup_check" | "traffic" | null;
};

/** The check's remediation sentence, when the verdict carries one. */
export function checkRemediation(check: ProviderConnectionCheck): string | null {
  const remediation = check.status_detail?.remediation;
  return typeof remediation === "string" && remediation.length > 0 ? remediation : null;
}

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The BYOK providers the add-a-key flow offers for one model: the model-scoped
 * set — the providers that already serve it in the catalog — or, when the
 * catalog names none a key can be connected to, the full provider list. The
 * fallback is deliberate: a user who picks "Add an API key" must ALWAYS get a
 * platform choice, even for a model whose only catalog route is one we cannot
 * connect a key to (a local endpoint, or a provider outside the BYOK enum).
 * Reads only each deployment's `provider`, so it takes the catalog rows raw.
 */
export function connectableProvidersForModel(
  deployments: readonly { provider: string }[]
): ModelProvider[] {
  const scoped: ModelProvider[] = [];
  for (const deployment of deployments) {
    if (isModelProvider(deployment.provider) && !scoped.includes(deployment.provider)) {
      scoped.push(deployment.provider);
    }
  }
  return scoped.length > 0 ? scoped : [...MODEL_PROVIDERS];
}

export function modelProviderLabel(provider: string): string {
  return isModelProvider(provider) ? PROVIDER_LABELS[provider] : provider;
}

/**
 * Azure's non-secret config: the resource endpoint, an optional API version,
 * and the deployment name each catalog model type is served under (Azure
 * addresses deployments, not model ids, so a key alone cannot route). OpenAI
 * and Anthropic need nothing beside the key and carry `{}`.
 */
export type AzureProviderConfig = {
  endpoint: string;
  api_version?: string;
  deployments: Record<string, string>;
};

/**
 * Validate and normalize a submitted Azure config. Returns the config to store,
 * or a single customer-facing sentence naming what is missing. The route and the
 * panel share this so the API cannot accept a shape the serving side then fails
 * to read: a config that names no deployment can hold a valid key and still
 * route nothing, so an empty deployment map is refused here rather than at
 * serving time.
 */
function validatePublicHttps(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "The Azure endpoint must be a full https URL.";
  }
  if (url.protocol !== "https:" || url.hostname.length === 0) {
    return "The Azure endpoint must be a public https URL.";
  }
  // Trailing dots are the same host on the wire ("localhost." is localhost).
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const privateHost =
    host === "localhost" ||
    host === "host.docker.internal" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1";
  if (privateHost) {
    return "The Azure endpoint must be a public https URL, not an internal host.";
  }
  return null;
}

export function parseAzureConfig(value: unknown): AzureProviderConfig | { error: string } {
  const raw = isRecord(value) ? value : {};
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  if (endpoint.length === 0) {
    return { error: "An Azure Foundry resource endpoint is required." };
  }
  // Azure resources are public https origins; only the org's OWN key ever
  // rides there, but the API must not be steerable at internal or plaintext
  // targets through a stored connection (backend enforces the same rule).
  const publicHttpsError = validatePublicHttps(endpoint);
  if (publicHttpsError !== null) {
    return { error: publicHttpsError };
  }
  const apiVersion = typeof raw.api_version === "string" ? raw.api_version.trim() : "";
  if (raw.api_version !== undefined && typeof raw.api_version !== "string") {
    return { error: "The API version must be text." };
  }
  // WMO's exact contract, mirrored by the backend store model: rejecting a
  // bad value here fails at Settings save instead of inside a funded run.
  if (apiVersion.length > 0 && !/^(?:v1|\d{4}-\d{2}-\d{2}(?:-preview)?)$/.test(apiVersion)) {
    return { error: 'The API version must be "v1" or a dated version like 2024-05-01-preview.' };
  }
  if (raw.deployments !== undefined && !isRecord(raw.deployments)) {
    return { error: "Deployments must map each model to its Azure deployment name." };
  }
  const deployments: Record<string, string> = {};
  for (const [modelType, deployment] of Object.entries(raw.deployments ?? {})) {
    if (typeof deployment !== "string" || deployment.trim().length === 0) {
      return { error: `Name the Azure deployment serving ${modelType}.` };
    }
    if (modelType.trim().length === 0) {
      return { error: "Every deployment row needs the model it serves." };
    }
    deployments[modelType.trim()] = deployment.trim();
  }
  if (Object.keys(deployments).length === 0) {
    return { error: "Add at least one deployment so requests have somewhere to go." };
  }
  return apiVersion.length > 0
    ? { endpoint, api_version: apiVersion, deployments }
    : { endpoint, deployments };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bedrock's non-secret config: the region requests must call and the AWS
 * access-key id. The secret access key is the Vault credential; the key id is
 * an identifier that pairs with it (it appears in AWS consoles and request
 * signatures) and rides the row's config beside the region.
 */
export type BedrockProviderConfig = {
  region: string;
  access_key_id: string;
};

export function parseBedrockConfig(value: unknown): BedrockProviderConfig | { error: string } {
  const raw = isRecord(value) ? value : {};
  const region = typeof raw.region === "string" ? raw.region.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(region)) {
    return { error: "Name the AWS region Bedrock requests should call (e.g. us-east-1)." };
  }
  const accessKeyId = typeof raw.access_key_id === "string" ? raw.access_key_id.trim() : "";
  if (accessKeyId.length < 16 || accessKeyId.length > 128) {
    return { error: "The AWS access key id pairs with the secret and is required." };
  }
  return { region, access_key_id: accessKeyId };
}

/**
 * Fireworks' non-secret config: the account id billing reads address. It is
 * not discoverable from the key, so it is collected at hookup.
 */
export type FireworksProviderConfig = {
  account_id: string;
};

export function parseFireworksConfig(value: unknown): FireworksProviderConfig | { error: string } {
  const raw = isRecord(value) ? value : {};
  const accountId = typeof raw.account_id === "string" ? raw.account_id.trim() : "";
  if (accountId.length === 0 || accountId.length > 128) {
    return {
      error: "The Fireworks account id is required — it is the account slug on fireworks.ai."
    };
  }
  return { account_id: accountId };
}

/**
 * Modal's credential is a token PAIR — token id (ak-…) plus token secret
 * (as-…) — stored as one JSON Vault secret. Validating both prefixes here
 * catches a swapped or half-pasted pair at Settings save, with a message
 * naming which half is wrong.
 */
export function parseModalSecret(value: unknown): { secret: string } | { error: string } {
  const raw = isRecord(value) ? value : {};
  const tokenId = typeof raw.token_id === "string" ? raw.token_id.trim() : "";
  const tokenSecret = typeof raw.token_secret === "string" ? raw.token_secret.trim() : "";
  if (!tokenId.startsWith("ak-") || tokenId.length < 4) {
    return { error: "The Modal token id must start with ak- (from modal.com → Settings → API tokens)." };
  }
  if (!tokenSecret.startsWith("as-") || tokenSecret.length < 4) {
    return { error: "The Modal token secret must start with as- (shown once when the token is created)." };
  }
  return { secret: JSON.stringify({ token_id: tokenId, token_secret: tokenSecret }) };
}

/**
 * The providers that take an optional second credential — the provider ADMIN
 * key — used only for spend reporting. Admin and inference keys are disjoint
 * namespaces at both providers (live-tested), so each slot validates the
 * other's prefix out.
 */
export const SPEND_KEY_PROVIDERS = ["anthropic", "openai"] as const;

export type SpendKeyProvider = (typeof SPEND_KEY_PROVIDERS)[number];

export function isSpendKeyProvider(provider: string): provider is SpendKeyProvider {
  return (SPEND_KEY_PROVIDERS as readonly string[]).includes(provider);
}

const ADMIN_KEY_PREFIXES: Record<SpendKeyProvider, string> = {
  anthropic: "sk-ant-admin",
  openai: "sk-admin-"
};

/**
 * Validate a key pasted in the ADMIN slot. An inference key here is refused
 * with a message naming both key types, so the user learns which slot each
 * belongs in instead of getting a 401 later.
 */
export function parseSpendSecret(
  provider: SpendKeyProvider,
  value: unknown
): { secret: string } | { error: string } {
  const secret = typeof value === "string" ? value.trim() : "";
  if (secret.length === 0) {
    return { error: "An admin key is required when one is provided." };
  }
  if (!secret.startsWith(ADMIN_KEY_PREFIXES[provider])) {
    return {
      error:
        provider === "anthropic"
          ? "That looks like an Anthropic inference key (sk-ant-api…), but the admin slot " +
            "needs an ADMIN key (sk-ant-admin…) — the two key types are disjoint. The " +
            "inference key belongs in the main API-key field."
          : "That looks like an OpenAI project/inference key (sk-…), but the admin slot " +
            "needs an ADMIN key (sk-admin-…, scope api.usage.read) — the two key types " +
            "are disjoint. The project key belongs in the main API-key field."
    };
  }
  return { secret };
}

/**
 * Catch an ADMIN key pasted in the MAIN slot before it is stored: it would
 * save fine and then fail every inference call. Returns the explanatory
 * error naming both key types, or null when the key belongs there.
 */
export function mainSlotAdminKeyError(provider: ModelProvider, secret: string): string | null {
  if (provider === "anthropic" && secret.startsWith(ADMIN_KEY_PREFIXES.anthropic)) {
    return (
      "That is an Anthropic ADMIN key (sk-ant-admin…), which cannot do inference — the " +
      "two key types are disjoint. Paste an inference API key (sk-ant-api…) here; the " +
      "admin key belongs in the optional admin-key field."
    );
  }
  if (provider === "openai" && secret.startsWith(ADMIN_KEY_PREFIXES.openai)) {
    return (
      "That is an OpenAI ADMIN key (sk-admin-…), which does not serve inference — the " +
      "two key types are disjoint. Paste a project API key (sk-…) here; the admin key " +
      "belongs in the optional admin-key field."
    );
  }
  return null;
}

/**
 * One (connection x model) Azure deployment verdict, as the deployment-check
 * endpoint returns it. Deliberately not a connection status: the key stays
 * `valid` and this fact rides `status_detail.models[model]`.
 */
export type ModelDeploymentCheck = {
  provider: string;
  model: string;
  deployment: string;
  deployed: boolean;
  checked_at: string;
  detail: Record<string, unknown> | null;
};

/** The stored model-scoped deployment fact, read back from a connection's status_detail. */
export type ModelDeploymentFact = {
  deployment: string;
  deployed: boolean;
  checked_at: string | null;
  remediation: string | null;
};

/**
 * The persisted (connection x model) fact under `status_detail.models`, when
 * one exists. Null means the deployment has never been checked for this
 * model — not that it is missing.
 */
export function modelDeploymentFact(
  detail: Record<string, unknown> | null,
  model: string
): ModelDeploymentFact | null {
  const models = detail?.models;
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    return null;
  }
  const fact = (models as Record<string, unknown>)[model];
  if (typeof fact !== "object" || fact === null || Array.isArray(fact)) {
    return null;
  }
  const record = fact as Record<string, unknown>;
  if (typeof record.deployment !== "string" || typeof record.deployed !== "boolean") {
    return null;
  }
  return {
    deployment: record.deployment,
    deployed: record.deployed,
    checked_at: typeof record.checked_at === "string" ? record.checked_at : null,
    remediation: typeof record.remediation === "string" ? record.remediation : null
  };
}

/** The three snapshot sources, exactly the backend's enum. */
export type ProviderSnapshotSource = "provider_api" | "our_side" | "self_reported";

/**
 * One provider account reading, as the spend-refresh endpoint returns it and
 * as the settings/Overview surfaces read it back from the snapshots table.
 */
export type ProviderAccountSnapshot = {
  taken_at: string;
  source: ProviderSnapshotSource;
  spend_usd: number | null;
  credits_remaining_usd: number | null;
  usage_limit_usd: number | null;
  detail: Record<string, unknown> | null;
};

/**
 * The spend-refresh verdict: reported numbers (fresh or floor-served),
 * the provider's honest "doesn't report this" state, or a failed read.
 */
export type ProviderSpendRefresh = {
  provider: string;
  kind: "reported" | "not_reportable" | "read_failed";
  refreshed: boolean;
  staleness_floor_seconds: number;
  next_refresh_at: string | null;
  message: string;
  snapshot: ProviderAccountSnapshot | null;
};
