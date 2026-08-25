import { describe, expect, it } from "vitest";

import {
  buildByokConnectPrompt,
  buildFirstCallPrompt
} from "@/components/auth/welcome-prompts";

const KEY = "xpl_livekey";

describe("buildFirstCallPrompt", () => {
  const prompt = buildFirstCallPrompt("https://api.example", KEY);

  it("grounds the agent in the real serving surface and embeds the key", () => {
    expect(prompt).toContain("EXPLABS_API_KEY=xpl_livekey");
    expect(prompt).toContain("GET https://api.example/v1/models");
    expect(prompt).toContain('base_url="https://api.example/v1"');
    expect(prompt).toContain("qwen3.8-27b");
  });

  it("reads the key from the env and uses the discovered model id, not a literal", () => {
    // The SDK examples must read the process env, not pass the literal string.
    expect(prompt).toContain('os.environ["EXPLABS_API_KEY"]');
    expect(prompt).not.toContain('api_key="$EXPLABS_API_KEY"');
    // The OpenAI example must use the id chosen during discovery, not hard-code.
    expect(prompt).toContain('model="<the promo Qwen id from step 1>"');
  });

  it("offers the Anthropic lane with the no-/v1 base URL and its text-only caveat", () => {
    // The Anthropic SDK appends /v1/messages itself, so its base URL omits /v1.
    expect(prompt).toContain('base_url="https://api.example"');
    expect(prompt).toContain("no extended thinking");
  });

  it("sends a minimal body to avoid all_routes_failed on strict models", () => {
    expect(prompt).toContain("no temperature, top_p");
    expect(prompt).toContain("all_routes_failed");
  });

  it("leaves a fill-in slot when no key was minted", () => {
    expect(buildFirstCallPrompt("https://api.example", null)).toContain(
      "<paste my xpl_ org API key here>"
    );
  });

  it("uses no em dashes in the authored copy", () => {
    expect(prompt).not.toMatch(/—/);
  });
});

describe("buildByokConnectPrompt", () => {
  const prompt = buildByokConnectPrompt("https://web.example", "https://api.example", KEY);

  it("reuses the local key-find and connect steps as its body", () => {
    expect(prompt).toContain("Find my API keys locally, by prefix");
    expect(prompt).toContain(
      "PUT https://api.example/api/orgs/<org-id>/provider-connections/<provider>"
    );
    expect(prompt).toContain("EXPLABS_API_KEY=xpl_livekey");
  });

  it("points at the settings fallback and stays generic (no YC framing)", () => {
    expect(prompt).toContain("https://web.example/settings/integrations");
    expect(prompt).not.toMatch(/YC|Y Combinator|Combinator/);
  });

  it("leaves a fill-in slot when no key was minted", () => {
    expect(buildByokConnectPrompt("https://web.example", "https://api.example", null)).toContain(
      "<paste my org API key from https://web.example/settings/api-keys>"
    );
  });

  it("uses no em dashes in the authored copy", () => {
    expect(prompt).not.toMatch(/—/);
  });
});
