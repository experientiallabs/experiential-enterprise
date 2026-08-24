import { buildInstantSignupSteps } from "@/components/account-creation/setup-prompt";
import { buildAgentIntegrationPrompt } from "@/components/coding-agents/setup-prompt";
import { buildTraceTelemetryPrompt } from "@/components/trace-onboarding/setup-prompt";
import { buildGatewaySetupPrompt } from "@/components/onboarding/setup-prompt";

// The ONE registry of copy-paste setup prompts. Both the /docs "Setup prompts"
// page and the machine-readable /llms.txt render from this list, and the list
// renders from the SAME builders the in-app welcome/onboarding modals use
// (components/account-creation, components/trace-onboarding, components/onboarding), so
// there is exactly one source of truth for the prompt text across the app, the
// docs, and llms.txt. Never paste a second copy of a prompt string here or in
// either consumer; add or reorder builders instead.

// The public, shareable copies of these prompts (retiring the personal gists).
// The in-app builders remain the source of truth; this is only an external link.
export const SETUP_PROMPTS_REPO_URL = "https://github.com/experientiallabs/setup-prompts";

export type SetupPrompt = {
  /** Stable anchor id, also the docs section id. */
  id: string;
  title: string;
  /** One line under the title on the docs page and above the prompt in llms.txt. */
  description: string;
  /** The rendered, paste-able prompt body, base URLs already interpolated. */
  prompt: string;
};

/**
 * Build the ordered setup prompts for a deployment, base URLs interpolated.
 *
 * @param webBaseUrl - Public web origin (dashboard, sign-in, verification).
 * @param apiBaseUrl - Public API base URL (`/api` control plane, `/v1` gateway).
 * @returns The prompts in the order both docs and llms.txt present them.
 */
export function buildSetupPrompts(webBaseUrl: string, apiBaseUrl: string): readonly SetupPrompt[] {
  return [
    {
      id: "create-account",
      title: "Create an account from your coding agent",
      description:
        "Paste into a CLI agent to create your account instantly from your email, wire the gateway, and confirm the key.",
      prompt: buildInstantSignupSteps(webBaseUrl, apiBaseUrl)
    },
    {
      id: "gateway-setup",
      title: "Set up the gateway in an existing project",
      description:
        "Paste into your agent once you have a key: point an OpenAI client at the gateway and make one test call.",
      prompt: buildGatewaySetupPrompt(webBaseUrl, apiBaseUrl, null)
    },
    {
      id: "agent-integration",
      title: "Wire your coding agent to the gateway",
      description:
        "Paste into Claude Code, Codex, OpenCode, Cline, Conductor, or any OpenAI-SDK tool: the agent identifies itself and applies its own verified integration.",
      prompt: buildAgentIntegrationPrompt(webBaseUrl, apiBaseUrl)
    },
    {
      id: "traces-telemetry",
      title: "Bring your traces in as telemetry",
      description:
        "Paste into a CLI agent to create your account instantly and land your existing LLM traces as telemetry.",
      prompt: buildTraceTelemetryPrompt(webBaseUrl, apiBaseUrl)
    }
  ];
}
