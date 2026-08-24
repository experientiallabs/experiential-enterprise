import { describe, expect, it } from "vitest";

import { MODEL_PROVIDERS } from "@/lib/model-providers";
import {
  PROVIDER_FIELD_SCHEMAS,
  isProviderFormReady,
  providerFieldSchema,
  type ProviderFormValues
} from "@/lib/provider-fields";

function values(overrides: Partial<ProviderFormValues> = {}): ProviderFormValues {
  return {
    secret: "",
    tokenId: "",
    tokenSecret: "",
    config: {},
    hasDeployment: false,
    ...overrides
  };
}

describe("provider field schema", () => {
  it("covers every provider in the enum", () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(providerFieldSchema(provider).provider).toBe(provider);
    }
    expect(Object.keys(PROVIDER_FIELD_SCHEMAS).sort()).toEqual([...MODEL_PROVIDERS].sort());
  });

  it("gives plain providers a single API-key secret and no config", () => {
    for (const provider of ["openai", "anthropic", "gemini", "openrouter"] as const) {
      const schema = providerFieldSchema(provider);
      expect(schema.secret.kind).toBe("single");
      expect(schema.config).toEqual([]);
      expect(schema.hasDeployments).toBe(false);
    }
    // Only OpenAI and Anthropic take the optional admin/spend key.
    expect(providerFieldSchema("openai").hasSpendKey).toBe(true);
    expect(providerFieldSchema("anthropic").hasSpendKey).toBe(true);
    expect(providerFieldSchema("gemini").hasSpendKey).toBe(false);
    expect(providerFieldSchema("openrouter").hasSpendKey).toBe(false);
  });

  it("requires Azure's endpoint plus a deployment, and marks api_version optional", () => {
    const schema = providerFieldSchema("azure_openai");
    expect(schema.hasDeployments).toBe(true);
    const endpoint = schema.config.find((field) => field.name === "endpoint");
    const apiVersion = schema.config.find((field) => field.name === "api_version");
    expect(endpoint?.required).toBe(true);
    expect(endpoint?.type).toBe("url");
    expect(apiVersion?.required).toBe(false);
  });

  it("requires the Bedrock triple's key id and region", () => {
    const schema = providerFieldSchema("bedrock");
    expect(schema.secret.kind).toBe("single");
    expect(schema.config.map((field) => field.name)).toEqual(["access_key_id", "region"]);
    expect(schema.config.every((field) => field.required)).toBe(true);
  });

  it("captures Modal as a token pair", () => {
    const schema = providerFieldSchema("modal");
    expect(schema.secret.kind).toBe("pair");
  });
});

describe("isProviderFormReady", () => {
  it("gates a plain provider on the key alone", () => {
    const schema = providerFieldSchema("openai");
    expect(isProviderFormReady(schema, values())).toBe(false);
    expect(isProviderFormReady(schema, values({ secret: "sk-abc" }))).toBe(true);
  });

  it("gates Azure on the key, the endpoint, and at least one deployment", () => {
    const schema = providerFieldSchema("azure_openai");
    // Key alone is not enough.
    expect(isProviderFormReady(schema, values({ secret: "azkey" }))).toBe(false);
    // Key + endpoint but no deployment: still blocked.
    expect(
      isProviderFormReady(
        schema,
        values({ secret: "azkey", config: { endpoint: "https://r.openai.azure.com" } })
      )
    ).toBe(false);
    // Key + endpoint + a deployment: ready. api_version stays optional.
    expect(
      isProviderFormReady(
        schema,
        values({
          secret: "azkey",
          config: { endpoint: "https://r.openai.azure.com" },
          hasDeployment: true
        })
      )
    ).toBe(true);
  });

  it("gates Bedrock on the secret plus the key id and region", () => {
    const schema = providerFieldSchema("bedrock");
    expect(isProviderFormReady(schema, values({ secret: "aws-secret" }))).toBe(false);
    expect(
      isProviderFormReady(
        schema,
        values({ secret: "aws-secret", config: { access_key_id: "AKIA", region: "us-east-1" } })
      )
    ).toBe(true);
  });

  it("gates Modal on both halves of the token pair", () => {
    const schema = providerFieldSchema("modal");
    expect(isProviderFormReady(schema, values({ tokenId: "ak-1" }))).toBe(false);
    expect(isProviderFormReady(schema, values({ tokenId: "ak-1", tokenSecret: "as-2" }))).toBe(true);
  });
});
