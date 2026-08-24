import { describe, expect, it } from "vitest";

import {
  buildAgentIntegrationPrompt,
  buildAgentPrompt,
  type CodingAgentId
} from "@/components/coding-agents/setup-prompt";

// The self-selecting integration prompt must carry each agent's contract
// facts exactly as /docs/coding-agents documents them — these assertions pin
// the load-bearing values, not the prose.
describe("buildAgentIntegrationPrompt", () => {
  const web = "https://platform.example.ai";
  const api = "https://api.example.ai";
  const prompt = buildAgentIntegrationPrompt(web, api);

  it("covers every supported agent by name", () => {
    for (const agent of ["Claude Code", "Codex CLI", "OpenCode", "Cline", "Conductor"]) {
      expect(prompt).toContain(agent);
    }
  });

  it("keeps the Anthropic base URL suffix-free and the OpenAI ones on /v1", () => {
    expect(prompt).toContain(`ANTHROPIC_BASE_URL="${api}"`);
    expect(prompt).toContain(`ANTHROPIC_BASE_URL = "${api}"`);
    expect(prompt).not.toContain(`ANTHROPIC_BASE_URL="${api}/v1`);
    expect(prompt).toContain(`base_url = "${api}/v1"`);
    expect(prompt).toContain(`OPENAI_BASE_URL="${api}/v1"`);
  });

  it("pins the per-agent contract facts", () => {
    expect(prompt).toContain('wire_api = "responses"');
    expect(prompt).toContain("requires_openai_auth");
    expect(prompt).toContain('ANTHROPIC_API_KEY = ""');
    expect(prompt).toContain("@ai-sdk/openai-compatible");
    expect(prompt).toContain("OpenAI Compatible");
  });

  it("carries the key-safety and consent boundaries", () => {
    expect(prompt).toContain("never print my full key");
    expect(prompt).toContain("before you edit any config file or shell profile");
    expect(prompt).toContain("git-ignored before writing my key");
  });

  it("verifies before and after configuring", () => {
    expect(prompt).toContain(`GET ${api}/v1/models`);
    expect(prompt).toContain("reply with the single word: ok");
    expect(prompt).toContain(`${web}/telemetry`);
  });

  it("builds a focused prompt per agent, sharing one scaffold", () => {
    const agents: CodingAgentId[] = [
      "claude-code",
      "conductor",
      "codex",
      "opencode",
      "cline",
      "openai-compatible"
    ];
    for (const agent of agents) {
      const single = buildAgentPrompt(agent, web, api);
      // Same safety scaffold as the combined prompt.
      expect(single).toContain("never print my full key");
      expect(single).toContain(`GET ${api}/v1/models`);
      expect(single).toContain(`${web}/telemetry`);
      // ...but only ONE agent's steps, never the self-selecting list.
      expect(single).not.toContain("Identify which agent you are");
    }
  });

  it("scopes each per-agent prompt to that agent's own contract", () => {
    expect(buildAgentPrompt("codex", web, api)).toContain('wire_api = "responses"');
    expect(buildAgentPrompt("codex", web, api)).not.toContain("ANTHROPIC_BASE_URL");
    expect(buildAgentPrompt("claude-code", web, api)).toContain(`ANTHROPIC_BASE_URL="${api}"`);
    expect(buildAgentPrompt("claude-code", web, api)).not.toContain("wire_api");
    expect(buildAgentPrompt("conductor", web, api)).toContain('ANTHROPIC_API_KEY = ""');
    expect(buildAgentPrompt("opencode", web, api)).toContain("@ai-sdk/openai-compatible");
    expect(buildAgentPrompt("cline", web, api)).toContain("OpenAI Compatible");
    expect(buildAgentPrompt("openai-compatible", web, api)).toContain("OPENAI_BASE_URL");
  });

  it("keeps the combined prompt a composition of the same blocks", () => {
    // No agent's steps may be written twice: every per-agent body must appear
    // verbatim (modulo indentation) inside the self-selecting prompt.
    const squash = (text: string) => text.replace(/\s+/g, " ");
    const combined = squash(buildAgentIntegrationPrompt(web, api));
    for (const marker of [
      'wire_api = "responses"',
      'ANTHROPIC_API_KEY = ""',
      "@ai-sdk/openai-compatible",
      "OpenAI Compatible"
    ]) {
      expect(combined).toContain(squash(marker));
    }
  });
});
