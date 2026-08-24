// The per-provider add-key field schema: the single source of truth for which
// fields the connect form renders for each provider, their labels, placeholders,
// and required-ness, and how the credential secret is captured. Each provider is
// called differently (a plain API key, an Azure endpoint plus deployments, a
// Bedrock access-key-id/secret/region triple, a Modal token pair), so the form UI
// (provider-connect-form) and its client-side readiness gate both read from here
// instead of branching on the provider inline. The authoritative payload
// validation still lives in lib/model-providers (parseAzureConfig, parseBedrockConfig,
// ...) and on the backend; this schema drives the UI shape and the "can submit" gate.

import type { ModelProvider } from "@/lib/model-providers";

/** One scalar (non-secret) config field the form renders as a text input. */
export type ProviderConfigField = {
  /** The key this field is sent under inside the connection `config` payload. */
  name: string;
  /** The input's accessible label (also its visible intent). */
  label: string;
  placeholder: string;
  /** `url` renders a URL input with browser validation; `text` a plain one. */
  type: "text" | "url";
  /** Required fields gate submit and are always sent; optional ones only when filled. */
  required: boolean;
};

/** How a provider's credential secret is captured. */
export type ProviderSecretField =
  | {
      kind: "single";
      /** The input's accessible label ("OpenAI API key", "Bedrock secret access key"). */
      label: string;
      /** Placeholder when connecting for the first time. */
      placeholder: string;
      /** Placeholder when rotating an already-connected key. */
      rotatePlaceholder: string;
    }
  | {
      kind: "pair";
      /** Modal's token-id half (ak-...). */
      id: { label: string; placeholder: string; rotatePlaceholder: string };
      /** Modal's token-secret half (as-...). */
      secret: { label: string; placeholder: string; rotatePlaceholder: string };
    };

/** The complete field set the add-key form renders for one provider. */
export type ProviderFieldSchema = {
  provider: ModelProvider;
  secret: ProviderSecretField;
  /** Scalar config fields, in render order (endpoint, region, account id, ...). */
  config: ProviderConfigField[];
  /** Whether the Azure-style model to deployment map (the one composite field) shows. */
  hasDeployments: boolean;
  /** Whether the optional admin/spend key input shows (OpenAI, Anthropic). */
  hasSpendKey: boolean;
};

/** A plain "paste one API key" secret field, parameterized by provider label. */
function apiKeySecret(label: string): ProviderSecretField {
  return {
    kind: "single",
    label: `${label} API key`,
    placeholder: "API key",
    rotatePlaceholder: "Replace API key"
  };
}

/**
 * The field schema for every BYOK provider. Ordering within `config` matches the
 * order the fields render under the secret. Anything not listed here (OpenAI,
 * Anthropic, Gemini, OpenRouter) needs only a bare key.
 */
export const PROVIDER_FIELD_SCHEMAS: Record<ModelProvider, ProviderFieldSchema> = {
  openai: {
    provider: "openai",
    secret: apiKeySecret("OpenAI"),
    config: [],
    hasDeployments: false,
    hasSpendKey: true
  },
  anthropic: {
    provider: "anthropic",
    secret: apiKeySecret("Anthropic"),
    config: [],
    hasDeployments: false,
    hasSpendKey: true
  },
  gemini: {
    provider: "gemini",
    secret: {
      kind: "single",
      label: "Google Gemini API key",
      placeholder: "AI Studio API key",
      rotatePlaceholder: "Replace AI Studio API key"
    },
    config: [],
    hasDeployments: false,
    hasSpendKey: false
  },
  azure_openai: {
    provider: "azure_openai",
    secret: {
      kind: "single",
      label: "Azure Foundry API key",
      placeholder: "API key",
      rotatePlaceholder: "Replace API key"
    },
    config: [
      {
        name: "endpoint",
        label: "Azure Foundry resource endpoint",
        placeholder: "https://my-resource.openai.azure.com",
        type: "url",
        required: true
      },
      {
        name: "api_version",
        label: "Azure Foundry API version (optional)",
        placeholder: "API version (optional)",
        type: "text",
        required: false
      }
    ],
    hasDeployments: true,
    hasSpendKey: false
  },
  openrouter: {
    provider: "openrouter",
    secret: apiKeySecret("OpenRouter"),
    config: [],
    hasDeployments: false,
    hasSpendKey: false
  },
  bedrock: {
    provider: "bedrock",
    secret: {
      kind: "single",
      label: "Amazon Bedrock secret access key",
      placeholder: "Secret access key",
      rotatePlaceholder: "Replace secret access key"
    },
    config: [
      {
        name: "access_key_id",
        label: "AWS access key id",
        placeholder: "AWS access key id",
        type: "text",
        required: true
      },
      {
        name: "region",
        label: "AWS region",
        placeholder: "us-east-1",
        type: "text",
        required: true
      }
    ],
    hasDeployments: false,
    hasSpendKey: false
  },
  fireworks: {
    provider: "fireworks",
    secret: apiKeySecret("Fireworks AI"),
    config: [
      {
        name: "account_id",
        label: "Fireworks account id",
        placeholder: "Account id (the account slug on fireworks.ai)",
        type: "text",
        required: true
      }
    ],
    hasDeployments: false,
    hasSpendKey: false
  },
  modal: {
    provider: "modal",
    secret: {
      kind: "pair",
      id: {
        label: "Modal token id",
        placeholder: "Token id (ak-...)",
        rotatePlaceholder: "Replace token id (ak-...)"
      },
      secret: {
        label: "Modal token secret",
        placeholder: "Token secret (as-...)",
        rotatePlaceholder: "Replace token secret (as-...)"
      }
    },
    config: [],
    hasDeployments: false,
    hasSpendKey: false
  }
};

/** The schema for one provider (total over the ModelProvider union). */
export function providerFieldSchema(provider: ModelProvider): ProviderFieldSchema {
  return PROVIDER_FIELD_SCHEMAS[provider];
}

/** The current values the form holds for one provider's inputs. */
export type ProviderFormValues = {
  /** The single secret, or the empty string for a token-pair provider. */
  secret: string;
  /** Modal's token id, when the provider uses a token pair. */
  tokenId: string;
  /** Modal's token secret, when the provider uses a token pair. */
  tokenSecret: string;
  /** Scalar config values keyed by field name. */
  config: Record<string, string>;
  /** Whether at least one complete Azure deployment row is present. */
  hasDeployment: boolean;
};

/**
 * Whether the pasted values satisfy the provider's required fields, so the
 * submit button can enable. Mirrors, at the UI layer, the required-ness the
 * backend parsers enforce (secret present, required config present, Azure needs
 * at least one deployment); the parsers remain the authority on format.
 */
export function isProviderFormReady(
  schema: ProviderFieldSchema,
  values: ProviderFormValues
): boolean {
  const secretReady =
    schema.secret.kind === "pair"
      ? values.tokenId.trim().length > 0 && values.tokenSecret.trim().length > 0
      : values.secret.trim().length > 0;
  if (!secretReady) {
    return false;
  }
  const configReady = schema.config.every(
    (field) => !field.required || (values.config[field.name]?.trim().length ?? 0) > 0
  );
  if (!configReady) {
    return false;
  }
  return !schema.hasDeployments || values.hasDeployment;
}
