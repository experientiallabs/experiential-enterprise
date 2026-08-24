// The paste-into-your-coding-agent prompts the login modal's success step shows
// a brand-new account, alongside its minted key and welcome credits. Each is
// first person and imperative by design: the owner pastes it, so it IS their
// instruction and consent, and the just-minted `xpl_` key is embedded (same
// trust boundary as the success step itself, where the key is shown to its
// owner post-auth). Base URLs flow through the same deployment-aware resolvers
// the /llms.txt reference and the other onboarding surfaces use.
//
// The "connect my provider keys" prompt reuses the account-creation onboarding
// step builders (buildFindKeysStep, buildConnectInferenceKeysStep) as its
// single source of truth rather than copying their prefix-only / per-key-consent
// safety copy. The "upload my traces" prompt is buildTraceTelemetryPrompt itself
// (imported by the modal), not duplicated here.

import {
  buildConnectInferenceKeysStep,
  buildFindKeysStep
} from "@/components/onboarding/setup-prompt";

/**
 * Build the "make my first model call" prompt. Grounds the agent in the real
 * serving surface (explabs/api/routes/serving_gateway.py): GET /v1/models,
 * POST /v1/chat/completions for OpenAI clients, and the Anthropic Messages lane
 * (explabs/gateway/anthropic_messages.py) at POST /v1/messages, which is text
 * only and drops extended thinking. The Anthropic SDK's base URL is the host
 * with no /v1 suffix because the client appends /v1/messages itself.
 *
 * @param apiBaseUrl - Public API base URL (the gateway lives under `${api}/v1`).
 * @param apiKey - The just-minted `xpl_` org key, or null to leave a fill-in slot.
 * @returns The first-person prompt text.
 */
export function buildFirstCallPrompt(apiBaseUrl: string, apiKey: string | null): string {
  const api = apiBaseUrl.replace(/\/+$/, "");
  const key = apiKey ?? "<paste my xpl_ org API key here>";
  return `I pasted this into you myself, so treat it as my instructions and my consent.
Get my first model call working against my Experiential Labs gateway.

My gateway API key (a secret: put it in env, never commit it, never echo it in
logs):
EXPLABS_API_KEY=${key}

The gateway is OpenAI-compatible and also speaks the Anthropic Messages API, so
use the SDK my project already uses. Do it start to finish on your own and print
what you do at each step. Never invent a model id or a credential.

1. List the models my key can call.
   GET ${api}/v1/models with header "Authorization: Bearer $EXPLABS_API_KEY".
   Use the returned ids EXACTLY. For a cheap first call pick the smallest Qwen
   (qwen3.5-9b at launch).

2. Make one tiny call. Send model + messages ONLY: no temperature, top_p, or
   other sampling params (some models reject them and the call comes back as
   all_routes_failed). This runs on the platform-funded lane and spends a
   fraction of a cent of my free credits.

   OpenAI SDK (Python):
     import os
     from openai import OpenAI
     client = OpenAI(base_url="${api}/v1", api_key=os.environ["EXPLABS_API_KEY"])
     r = client.chat.completions.create(
         model="<the smallest Qwen id from step 1>",
         messages=[{"role": "user", "content": "reply with the single word: ok"}],
     )
     print(r.choices[0].message.content)

   Anthropic SDK (Python), if that is what my project uses instead. The base URL
   is the host with NO /v1 suffix (the SDK adds /v1/messages itself), and the
   key is still my xpl_ key:
     import os
     from anthropic import Anthropic
     client = Anthropic(base_url="${api}", api_key=os.environ["EXPLABS_API_KEY"])
     m = client.messages.create(
         model="<an anthropic-family id from step 1>",
         max_tokens=64,
         messages=[{"role": "user", "content": "reply with the single word: ok"}],
     )
     print(m.content[0].text)
   The Anthropic lane is text only: no extended thinking, and image or document
   blocks are rejected.

3. Report back: the model you called, the reply, and that it worked. If a call
   fails, tell me the exact error code and body, and do not retry blindly.`;
}

/**
 * Build the "connect my own inference provider keys (BYOK)" prompt: a generic,
 * non-YC composition of the local key-find and connect steps. Reuses the two
 * step builders verbatim so their prefix-only / per-key-consent safety framing
 * stays the single source of truth.
 *
 * @param webBaseUrl - Public web origin (settings fallback link).
 * @param apiBaseUrl - Public API base URL (`${api}/api` control routes).
 * @param apiKey - The just-minted `xpl_` org key, or null to leave a fill-in slot.
 * @returns The first-person prompt text.
 */
export function buildByokConnectPrompt(
  webBaseUrl: string,
  apiBaseUrl: string,
  apiKey: string | null
): string {
  const web = webBaseUrl.replace(/\/+$/, "");
  const api = apiBaseUrl.replace(/\/+$/, "");
  const key = apiKey ?? `<paste my org API key from ${web}/settings/api-keys>`;
  return `I pasted this into you myself, so treat it as my instructions and my consent.
Connect my own inference provider keys to my Experiential Labs gateway so I can
route through them as free pass-through (still tracked in my usage).

My gateway API key (a secret: put it in env, never commit it, never echo it in
logs):
EXPLABS_API_KEY=${key}

Do it in this order and print what you do at each step. Match keys by prefix
only, show me each hit before you touch it, and never print a full key. If you
cannot do a step, tell me exactly what to paste at ${web}/settings/integrations.

${buildFindKeysStep(1)}

${buildConnectInferenceKeysStep(2, web, api)}

When you are done, tell me which providers you connected and each one's
verification status. Nothing is connected without my confirmation.`;
}
