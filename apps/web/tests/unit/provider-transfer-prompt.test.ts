import { describe, expect, it } from "vitest";

import { buildProviderTransferPrompt } from "@/components/settings/provider-transfer-prompt";
import { MODEL_PROVIDERS } from "@/lib/model-providers";

const WEB = "https://web.test/";
const API = "https://api.test/";

describe("buildProviderTransferPrompt", () => {
  it("covers every connectable provider with a whoami + connect call", () => {
    for (const provider of MODEL_PROVIDERS) {
      const prompt = buildProviderTransferPrompt(provider, WEB, API);
      // Trailing slashes are trimmed like the other prompt builders.
      expect(prompt).toContain("GET https://api.test/api/whoami");
      expect(prompt).toContain(
        `PUT https://api.test/api/orgs/<org_id>/provider-connections/${provider}`
      );
      // The verdict is read from the response, never guessed.
      expect(prompt).toContain("check.status");
      expect(prompt).toContain("EXPLABS_API_KEY");
    }
  });

  it("gives key-only providers a bare secret body", () => {
    for (const provider of ["openai", "anthropic", "gemini", "openrouter"] as const) {
      const prompt = buildProviderTransferPrompt(provider, WEB, API);
      expect(prompt).toContain('"secret":');
      expect(prompt).not.toContain('"config":');
    }
  });

  it("names the optional admin key for OpenAI and Anthropic only", () => {
    expect(buildProviderTransferPrompt("openai", WEB, API)).toContain('"spend_secret"');
    expect(buildProviderTransferPrompt("anthropic", WEB, API)).toContain('"spend_secret"');
    expect(buildProviderTransferPrompt("gemini", WEB, API)).not.toContain('"spend_secret"');
    expect(buildProviderTransferPrompt("openrouter", WEB, API)).not.toContain('"spend_secret"');
  });

  it("asks Fireworks for the account id in config", () => {
    const prompt = buildProviderTransferPrompt("fireworks", WEB, API);
    expect(prompt).toContain('"account_id"');
    expect(prompt).toContain("fw_");
  });

  it("asks Azure for endpoint, api_version, and a deployment map, not a bare key", () => {
    const prompt = buildProviderTransferPrompt("azure_openai", WEB, API);
    expect(prompt).toContain('"endpoint"');
    expect(prompt).toContain('"api_version"');
    expect(prompt).toContain('"deployments"');
    expect(prompt).toContain(".openai.azure.com");
  });

  it("asks Bedrock for the access key id and region, secret in the credential slot", () => {
    const prompt = buildProviderTransferPrompt("bedrock", WEB, API);
    expect(prompt).toContain('"access_key_id"');
    expect(prompt).toContain('"region"');
    expect(prompt).toContain("secret access key");
  });

  it("asks Modal for the token pair, not a single key", () => {
    const prompt = buildProviderTransferPrompt("modal", WEB, API);
    expect(prompt).toContain('"token_id"');
    expect(prompt).toContain('"token_secret"');
    expect(prompt).toContain("ak-");
    expect(prompt).toContain("as-");
  });
});
