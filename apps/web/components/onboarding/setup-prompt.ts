// Shared, copy-paste onboarding prompt builders — the single source of truth for
// the gateway-setup prompt and the BYOK provider-key onboarding steps, rendered
// identically by the /docs "Setup prompts" page, /llms.txt (lib/setup-prompts),
// and the in-app login/welcome modal (components/auth/welcome-prompts). Written
// in FIRST PERSON as the human's own words (the product owner, 2026-08-20): the human pastes
// each into their own coding agent, so it IS their instruction and consent, and
// the just-minted `xpl_` key is embedded in the same trust boundary as the modal
// success step (shown to its owner post-auth). Base URLs flow through the
// deployment-aware resolvers /llms.txt uses.
//
// (Relocated from the removed components/yc/ surface, 2026-08-21: these builders
// were never YC-specific — buildGatewaySetupPrompt is the generic "set up the
// gateway in an existing project" prompt. The step number is a parameter because
// a composing prompt places these blocks at its own positions.)

/**
 * Step: find the human's own provider keys locally, by prefix. Prefix-only,
 * per-key consent, never prints a full key (the human-test safety boundary a
 * careful agent needs to not read this as exfiltration).
 */
export function buildFindKeysStep(step: number): string {
  return `${step}. Find my API keys locally, by prefix. I'm authorizing you to find them:
   search my .env and .env.local files, my shell rc files (.zshrc, .bashrc,
   .profile), and the common config paths (~/.config, ~/.aws/credentials,
   ~/.modal.toml) for values matching the prefixes below. Match by prefix
   ONLY. Show me each hit by its matched prefix alone (e.g. "sk-proj-…"),
   never print or echo a full key, and ask me about each one before you do
   anything with it.
   Inference providers (AI-callable). Offer to connect these to my gateway:
     openai      sk-proj-   (also sk-, admin sk-admin-)
     anthropic   sk-ant-
     gemini      AIza
     openrouter  sk-or-v1-
     fireworks   fw_
     modal       ak- (token id) and as- (token secret)
     huggingface hf_
     tinker      tml-
     bedrock/aws AKIA
     together    (a Together key)
   Other tools (NOT AI-callable). Just name the ones you find (they feed a
   future deals view); do NOT connect them to the gateway:
     posthog / arize   phx_        resend      re_
     e2b               e2b_        cursor      crsr_
     porter / supabase eyJ         braintrust  sk-b
     supabase          sbp_        linkedin    LATY…
   Some prefixes collide: phx_ is arize OR posthog; sk- is openai,
   anthropic, braintrust, or openrouter; eyJ is porter or supabase. When a
   prefix is ambiguous, show me the fuller matched prefix and ask me which
   service it is; never guess and connect.`;
}

/**
 * Step: connect the inference keys the human approves as BYOK pass-through.
 * Each connection is verified on save and only kept after the human confirms.
 */
export function buildConnectInferenceKeysStep(
  step: number,
  webBaseUrl: string,
  apiBaseUrl: string
): string {
  return `${step}. Connect the inference keys I approve. Models called on my own keys are
   free pass-through (no extra cost, still tracked in my credit and usage
   views). Use EXPLABS_API_KEY as the bearer token on both calls:
   GET ${apiBaseUrl}/api/whoami returns my organization; then, for each
   inference key I approve,
   PUT ${apiBaseUrl}/api/orgs/<org-id>/provider-connections/<provider>
   (provider: openai, anthropic, gemini, openrouter, azure_openai, bedrock,
   fireworks, modal) with body {"secret": "<key>"}. For anthropic and openai
   I can also hand you an admin key to include as
   {"spend_secret": "<admin key>"} so spend reporting works. The keys land
   in my own gateway account and nowhere else; each response carries the
   verification verdict, so tell me every provider's status, and
   connect it only after I confirm it.
   If you can't: give me the list of what you found by prefix, and I'll paste the keys
   at ${webBaseUrl}/settings/integrations (verified on save the same way).`;
}

/**
 * The "set up the gateway in an existing project" prompt: point an
 * OpenAI-compatible client at the gateway with the pasted EXPLABS_API_KEY and
 * make one successful test chat completion, in ANY environment, WITHOUT ever
 * hard-blocking to ask the human a question. Richer onboarding (BYOK connect,
 * key sweep, spend import) is left as end-of-run follow-ups the human does in
 * the dashboard, so the pasted agent neither blocks nor risks reading them as
 * exfiltration.
 *
 * `apiKey` is the plaintext org key when this login minted one; null when the
 * org already held a key (hash-stored, unrecoverable), in which case the prompt
 * carries a fill-in slot pointing at the settings mint page.
 */
export function buildGatewaySetupPrompt(
  webBaseUrl: string,
  apiBaseUrl: string,
  apiKey: string | null
): string {
  const key = apiKey ?? `<paste my org API key from ${webBaseUrl}/settings/api-keys>`;
  return `I'm setting up Experiential Labs as this project's model gateway. I pasted
this myself, treat it as my instructions and my consent. Here's what I want
you to do.

My gateway API key (a secret: put it in env, never commit it, never echo it
in logs):
EXPLABS_API_KEY=${key}

The core task is ONE thing: point an OpenAI-compatible client at my gateway
with this key and make one successful test chat completion. Do it start to
finish on your own, do NOT stop to ask me questions. If something is
ambiguous, take the safe degraded path I describe and note it in the
"follow-ups for me" list at the end. Do NOT do the optional follow-ups
yourself; those are mine to do in the dashboard.

1. Wire a client to the gateway. base_url = ${apiBaseUrl}/v1, api key =
   EXPLABS_API_KEY (one header: Authorization: Bearer <key>). The API is
   OpenAI-compatible; nothing else changes.
   - If this working directory is clearly ONE project with an existing
     OpenAI client, wire that: set its base_url and key, put the key in the
     project's env scheme (.env plus an example entry), never in code. Show
     me the change first.
   - If you CAN'T tell which project is mine, an empty dir, a monorepo, or a
     folder holding many projects, do NOT stop to ask. Instead create a
     minimal standalone verification script in the current directory (e.g.
     explabs_smoke.py or explabs_smoke.mjs) that reads EXPLABS_API_KEY from
     the env and does the test call in step 2, and add "wire my specific
     project's client" to the follow-ups list at the end.

2. Make the test call. GET ${apiBaseUrl}/v1/models with the key as a bearer
   token and use model ids EXACTLY as returned. Then send ONE minimal chat
   completion (a few tokens) to the promotional Qwen in that list (qwen3.8-27b at
   launch). Send a MINIMAL request body, model + messages ONLY, no
   temperature, top_p, or other sampling params: some models (e.g. Claude 5)
   reject those and the call comes back as all_routes_failed (502). If you
   want to add options later, check the model's supported params in
   ${webBaseUrl}/llms.txt first. This call runs on Experiential's
   platform-funded lane, a fraction of a cent of my free credits, and
   proves serving and billing end to end. Do NOT use any of my own provider
   keys for this test.
   If you truly can't run it (no network): still write the script, print the
   exact curl I can copy from ${webBaseUrl}/docs, and note it in the
   follow-ups.

3. Report back, then hand me the follow-ups. Tell me: what you changed (or the
   standalone script you created), and the test call's model, that it
   succeeded, and its cost. Then list "follow-ups for me", anything you
   deferred above, PLUS these optional steps, which are MINE to do in the
   dashboard (do NOT attempt them yourself, and don't block on them):
   - Wire my specific project's client, if you only created a standalone
     script (skip this line if you already wired a real project).
   - Connect my own provider keys (BYOK) for free pass-through. I'll add them
     at ${webBaseUrl}/settings/integrations, verified on save, confirmed per
     key by prefix, landing in my own gateway account and nowhere else.
   - Import my existing Claude Code / Codex usage history (metadata only) so
     my dashboard opens with real spend, from ${webBaseUrl}/settings.
   - Review all my balances and spend, platform-funded credits and free
     pass-through both, at ${webBaseUrl}/credits, summarized on my Overview.

Read the contract if you build further: ${webBaseUrl}/docs (human docs) and
${webBaseUrl}/llms.txt (machine-readable: honored and refused parameters,
error codes, streaming caveats). Follow it literally.`;
}
