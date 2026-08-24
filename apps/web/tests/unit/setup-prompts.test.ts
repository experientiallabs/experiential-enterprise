import { describe, expect, it } from "vitest";

import { buildInstantSignupSteps } from "@/components/account-creation/setup-prompt";
import { buildAgentIntegrationPrompt } from "@/components/coding-agents/setup-prompt";
import { buildTraceTelemetryPrompt } from "@/components/trace-onboarding/setup-prompt";
import { buildGatewaySetupPrompt } from "@/components/onboarding/setup-prompt";
import { buildSetupPrompts } from "@/lib/setup-prompts";

// The registry must stay a thin, non-duplicating view over the canonical prompt
// builders (single source of truth) with base URLs interpolated.
describe("buildSetupPrompts", () => {
  const web = "https://platform.example.ai";
  const api = "https://api.example.ai";
  const prompts = buildSetupPrompts(web, api);

  it("returns the four registered prompts with stable ids", () => {
    expect(prompts.map((entry) => entry.id)).toEqual([
      "create-account",
      "gateway-setup",
      "agent-integration",
      "traces-telemetry"
    ]);
  });

  it("renders each prompt from its shared builder, not a hardcoded copy", () => {
    const byId = Object.fromEntries(prompts.map((entry) => [entry.id, entry.prompt]));
    expect(byId["create-account"]).toBe(buildInstantSignupSteps(web, api));
    expect(byId["gateway-setup"]).toBe(buildGatewaySetupPrompt(web, api, null));
    expect(byId["agent-integration"]).toBe(buildAgentIntegrationPrompt(web, api));
    expect(byId["traces-telemetry"]).toBe(buildTraceTelemetryPrompt(web, api));
  });

  it("interpolates the given base URLs into every prompt", () => {
    for (const entry of prompts) {
      expect(entry.prompt).toContain(api);
      expect(entry.prompt).toContain(web);
    }
  });
});
