// The coding-agent integration prompts — the single source of truth behind
// BOTH the per-agent "Prompt" tab on /docs/coding-agents and the
// self-selecting prompt the setup-prompts registry (lib/setup-prompts.ts)
// renders into /docs/setup-prompts and /llms.txt.
//
// One agent's instructions exist exactly once, in AGENT_BLOCKS below:
// buildAgentPrompt() wraps a single block in the shared preamble/verify/recap
// scaffold, and buildAgentIntegrationPrompt() composes every block into the
// "identify yourself" variant. Never write an agent's steps a second time in
// either consumer.
//
// First person and imperative, like every prompt in the registry: pasting one
// is the human's own instruction and consent. CLI agents that can edit files
// configure themselves; GUI-configured agents print exact manual steps.
//
// Keep each block in lockstep with that agent's section on
// /docs/coding-agents (apps/web/app/docs/coding-agents/page.tsx): both state
// the ONE shipped contract per agent.

/** Every agent the gateway has a verified integration for, in docs order. */
export type CodingAgentId =
  | "claude-code"
  | "conductor"
  | "codex"
  | "opencode"
  | "cline"
  | "openai-compatible";

type AgentBlock = {
  /** Human label, matching the docs section heading. */
  title: string;
  /** The agent's own steps, already indented for a prompt list item. */
  body: (web: string, api: string) => string;
};

const AGENT_BLOCKS: Record<CodingAgentId, AgentBlock> = {
  "claude-code": {
    title: "Claude Code",
    body: (_web, api) => `You cannot repoint yourself mid-session. Offer me two placements and apply
the one I pick: (a) append to my shell profile, or (b) print for one-off use:
  export ANTHROPIC_BASE_URL="${api}"        # no /v1 suffix
  export ANTHROPIC_AUTH_TOKEN="<my key>"
  export ANTHROPIC_MODEL="<slug I pick>"
Then tell me to restart you from a shell with those set. Warn me plainly:
extended thinking is unavailable through the gateway and image pastes are
rejected (the lane is text-only).`
  },
  conductor: {
    title: "Conductor",
    body: (_web, api) => `Print these for me to put in Settings -> Environment (Claude Code section),
or write them to this repo's .conductor/settings.local.toml under
[environment_variables] if I prefer (make sure that file is
git-ignored before writing my key into it):
  ANTHROPIC_BASE_URL = "${api}"
  ANTHROPIC_AUTH_TOKEN = "<my key>"
  ANTHROPIC_API_KEY = ""
The empty ANTHROPIC_API_KEY is required: it stops Claude Code from trying to
authenticate with Anthropic directly.`
  },
  codex: {
    title: "OpenAI Codex CLI",
    body: (_web, api) => `Add to ~/.codex/config.toml (create it if missing, show me the diff before
writing):
  model = "<slug I pick>"
  model_provider = "explabs"
  [model_providers.explabs]
  name = "Experiential Labs"
  base_url = "${api}/v1"
  env_key = "EXPLABS_API_KEY"
  wire_api = "responses"
Leave requires_openai_auth unset, and make sure EXPLABS_API_KEY is exported
where I launch you.`
  },
  opencode: {
    title: "OpenCode",
    body: (_web, api) => `Write the provider block into this project's opencode.json (or
~/.config/opencode/opencode.json if I prefer global — ask):
  {"provider": {"explabs": {"npm": "@ai-sdk/openai-compatible",
   "name": "Experiential Labs",
   "options": {"baseURL": "${api}/v1", "apiKey": "{env:EXPLABS_API_KEY}"},
   "models": {"<slug>": {"name": "<slug>"}}}}
Fill limit.context/limit.output for each slug from
GET ${api}/api/models/<slug> so my context window is right.`
  },
  cline: {
    title: "Cline",
    body: (_web, api) => `Your settings live in the VS Code UI, so print these for me to set by hand:
API Provider "OpenAI Compatible"; Base URL ${api}/v1; API Key = my key (no
Bearer prefix); Model ID = a slug from step 2; and per-model context window /
max output tokens from ${api}/api/models/<slug>.`
  },
  "openai-compatible": {
    title: "Any other OpenAI-compatible tool",
    body: (_web, api) => `Export OPENAI_BASE_URL="${api}/v1" and OPENAI_API_KEY="<my key>" wherever I
launch you, and name models by slug. If your own config wants the values
instead, it needs the same three: base URL ${api}/v1, my key, and a slug.`
  }
};

/** Indent a block's lines to sit under a numbered prompt step. */
function indent(body: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return body
    .split("\n")
    .map((line) => (line ? `${pad}${line}` : line))
    .join("\n");
}

function preamble(web: string, api: string): string {
  return `I pasted this into you myself — wire THIS coding agent up to my Experiential
Labs gateway, so my model calls route through ${api} and show up in my usage.

Ground rules: never print my full key (first 8 characters at most), ask me
before you edit any config file or shell profile, and if you cannot do a step
(no file access, settings live in a GUI), print the exact manual steps for me
instead. Print what you're doing at each step.

1. Get my key. Use EXPLABS_API_KEY from my environment if it is set; otherwise
   ask me to paste one (I can mint it at ${web}/settings/api-keys). It looks
   like xpl_ followed by 40 hex characters.

2. Prove the key works before touching any config:
   GET ${api}/v1/models with header "Authorization: Bearer <key>" -> 200 and
   the model slugs I can call. Remember the list; I'll pick models from it.`;
}

function closing(web: string): string {
  return `4. Verify end to end. Make one tiny completion with the surface you configured
   ("reply with the single word: ok", small max output) — via your own next
   model call if you now route through the gateway, otherwise via curl with my
   key. Then tell me it landed and that I can watch every call at
   ${web}/telemetry.

5. Recap exactly what you changed (files and values, key shown as xpl_ prefix
   only) so I can undo it later.`;
}

/**
 * Build the paste-able prompt for ONE agent (the docs "Prompt" tab).
 *
 * @param agent - Which agent's integration to apply.
 * @param webBaseUrl - Public web origin (key minting, telemetry).
 * @param apiBaseUrl - Public API base URL (`/v1` inference, `/api` control).
 * @returns The first-person prompt text for that agent.
 */
export function buildAgentPrompt(
  agent: CodingAgentId,
  webBaseUrl: string,
  apiBaseUrl: string
): string {
  const web = webBaseUrl.replace(/\/+$/, "");
  const api = apiBaseUrl.replace(/\/+$/, "");
  const block = AGENT_BLOCKS[agent];
  return `${preamble(web, api)}

3. Apply the ${block.title} integration:
${indent(block.body(web, api), 3)}

${closing(web)}`;
}

/**
 * Build the self-selecting prompt covering every supported agent.
 *
 * @param webBaseUrl - Public web origin (key minting, telemetry).
 * @param apiBaseUrl - Public API base URL (`/v1` inference, `/api` control).
 * @returns The first-person prompt text.
 */
export function buildAgentIntegrationPrompt(webBaseUrl: string, apiBaseUrl: string): string {
  const web = webBaseUrl.replace(/\/+$/, "");
  const api = apiBaseUrl.replace(/\/+$/, "");
  const blocks = (Object.keys(AGENT_BLOCKS) as CodingAgentId[])
    .map((id) => {
      const block = AGENT_BLOCKS[id];
      return `   - ${block.title}:\n${indent(block.body(web, api), 5)}`;
    })
    .join("\n\n");
  return `${preamble(web, api)}

3. Identify which agent you are and apply YOUR integration:

${blocks}

${closing(web)}`;
}
