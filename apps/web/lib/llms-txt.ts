// The /llms.txt body: the machine-readable reference an agent reads to use the
// gateway end to end. Everything here is verified against the shipped backend
// contract: the /v1 edge proxy (explabs/api/routes/serving_gateway.py) in
// front of the Experiential gateway worker, the models catalog and
// waterfall routes (explabs/api/routes/models_catalog.py), the control-plane
// reads (explabs/api/routes/gateway_admin.py), BYOK provider connections
// (explabs/api/routes/provider_connections.py), and the customer-key route
// allowlist (explabs/api/app.py). When any of those change, this file changes
// with them. Imperative and exact by design: an agent follows this literally,
// so no marketing copy and no vague "you can".
//
// Base URLs flow through the ONE resolver (endpoint-snippets.tsx): the hosted
// platform by default, the deployment's own URL when EXPLABS_PUBLIC_BACKEND_URL
// is set, so a self-hosted stack's /llms.txt documents itself.

import {
  PLATFORM_SERVING_BASE_URL,
  publicServingBaseUrl
} from "@/components/world-models/endpoint-snippets";
import { buildSetupPrompts, SETUP_PROMPTS_REPO_URL } from "@/lib/setup-prompts";

export const PLATFORM_WEB_URL = "https://platform.experientiallabs.ai";

export function buildLlmsTxt(options?: { apiBaseUrl?: string; webBaseUrl?: string }): string {
  const api = options?.apiBaseUrl ?? publicServingBaseUrl();
  const web = options?.webBaseUrl ?? PLATFORM_WEB_URL;
  const hosted = api === PLATFORM_SERVING_BASE_URL;
  // Rendered from the ONE shared registry the /docs "Setup prompts" page and
  // the in-app onboarding modals also use, so the paste-able prompts stay
  // identical across every surface.
  const setupPrompts = buildSetupPrompts(web, api)
    .map((entry) => `### ${entry.title}\n${entry.description}\n\n${entry.prompt}`)
    .join("\n\n");
  return `# Experiential Labs: machine-readable reference

Experiential Labs is an OpenAI-compatible model gateway: one base URL in front
of every model, spanning hosted providers, your own provider keys (bring-your-own-key),
our platform-funded credits, and self-hosted or custom models, plus a public
model catalog, per-model provider waterfalls, organization API keys, and usage
and credits. Point any OpenAI client at this gateway and change nothing else.
This file is the complete agent-facing reference. Human docs: ${web}/docs.
OpenAI-shared semantics: https://platform.openai.com/docs/api-reference

## Base URLs (local vs platform)

This deployment:
  API base URL: ${api}
  Web app:      ${web}
${
  hosted
    ? `This is the hosted platform. A self-hosted or local stack serves at its own
URL and its own copy of this file documents it.`
    : `This is a self-hosted or local deployment. The hosted platform is
${PLATFORM_SERVING_BASE_URL} (web: ${PLATFORM_WEB_URL}).`
}
OpenAI clients use base_url = "${api}/v1". The management API is under ${api}/api.

## Authentication

- One header, always: Authorization: Bearer <key>. No X-Api-Key, no query param.
- Keys look like xpl_ + 40 lowercase hex chars and are scoped to ONE
  organization. The secret is shown once, at creation.
- Mint a key by signing in to ${web}/settings/api-keys; the plaintext appears
  exactly once. Key creation and revocation are web-session actions, not API-key
  actions.
- One key reaches BOTH the inference surface (/v1/*) and the management API an
  agent needs: catalog reads, custom-model and waterfall writes, BYOK provider
  connections, usage reads, and the org's key list. It CANNOT mint or revoke
  keys, change another key's limits, or reach platform-admin routes.
- Bad or missing key: 401 with {"error":{"code":"invalid_key",
  "type":"authentication_error"}}. The 401 does not distinguish absent,
  malformed, revoked, or expired.
- Verify a key works: GET ${api}/v1/models with the key -> 200 and the org's
  callable models.

## Two lanes (how a call is paid for)

- pass_through: your own provider key (BYOK). No markup: the provider bills you
  directly. Connect keys at ${web}/settings.
- platform_funded: our credits. Public-catalog models are priced from the launch
  catalog; each call draws down your credit balance. No markup.
Which lane a model uses is decided by its provider waterfall. Either way, the
gateway adds zero markup.

## Models

- GET ${api}/v1/models lists the model slugs your key can call: the public
  catalog plus your organization's own custom and local models. Each id is a
  slug, e.g. "claude-opus-5", "gpt-5.5", "gemini-3.7-flash".
- A slug resolves through a provider waterfall: an ordered list of ways to reach
  the model (provider + provider model id). The gateway tries each rung in order,
  fails over on capacity and transport errors, and returns the first success.
  Organizations may override the default chain.
- The full catalog with pricing, context window, and modalities is a public,
  keyless read: GET ${api}/api/models (no key returns the public rows; send your
  key to also see your org's own custom and local models). One model:
  GET ${api}/api/models/<slug>; its deployments: .../providers. Note the split:
  the /api/models* catalog reads are keyless, while GET ${api}/v1/models (the
  OpenAI-compatible list) requires your key.

## OpenAI-compatible inference API

GET ${api}/v1/models
  -> {"object": "list", "data": [{"id": "<slug>", "object": "model",
     "owned_by": "exp", ...}]}
  Scoped to the key's organization.

POST ${api}/v1/chat/completions
  Standard OpenAI Chat Completions. "model" MUST be a slug from /v1/models.
  "stream": true streams as SSE.

POST ${api}/v1/responses
  Standard OpenAI Responses. "stream": true streams as SSE. "previous_response_id"
  continues a prior response on any worker instance; continuations are retained
  for 24 hours. An unknown or expired id -> 400 code=continuation_unavailable:
  resend the full conversation.

POST ${api}/v1/messages
  Anthropic Messages API, translated onto the same chat surface and models.
  Auth: x-api-key OR Authorization: Bearer (same xpl_ key). "stream": true
  streams Anthropic SSE events. Limits of the translation lane: extended
  thinking is unavailable (thinking config and blocks are accepted and
  dropped), image/document blocks -> 400 (the chat surface is text-only),
  Idempotency-Key is not honored here, /v1/messages/count_tokens answers an
  explicit 404 not_found_error (estimate locally), and errors use Anthropic's envelope
  {"type":"error","error":{"type","message"}} at the same statuses as below.

- Idempotency-Key is honored on the OpenAI routes: an exact retry with the same
  key replays the original result; the same key with a different body -> 409
  idempotency_conflict.
- Every other /v1/* path answers 404 code=not_found in the OpenAI error envelope.

## Error envelope (all /v1 routes; /v1/messages wraps the same statuses and
## meanings in Anthropic's envelope instead)

Errors are {"error": {"message", "type", "code", "param"?}}. Stable codes
(code -> HTTP status -> meaning -> recovery):
  invalid_json 400            body is not valid JSON -> fix the request.
  invalid_request 400         malformed request -> read message, fix, resend.
  invalid_parameter 400       a field is invalid ("param" names it) -> fix it.
  unsupported_capability 400  the model cannot do what you asked (a tool, a
                              modality, reasoning) -> pick a capable model; check
                              supported_params and modalities in /api/models.
  continuation_unavailable 400  previous_response_id is unknown or expired
                              -> resend the full conversation.
  invalid_key 401             missing/bad/expired/revoked key -> fix Authorization.
  model_not_granted 403       your org cannot call this slug -> use one from
                              /v1/models.
  idempotency_conflict 409    same Idempotency-Key, different body -> new key.
  idempotency_replay_unavailable 409/500  original keyed result gone after a
                              restart -> resend with a new Idempotency-Key.
  insufficient_quota 429      a spend limit or your credit balance is exhausted
                              (message says which: a daily org or per-model cap,
                              or credits) -> add credits or raise limits at
                              ${web}/credits (platform-funded lane).
  unavailable_route 429/503   throttled or no healthy route right now -> retry
                              with backoff.
  gateway_overloaded 429      -> retry with backoff.
  request_cancelled 499       the client disconnected before completion.
  all_routes_failed 502       every provider in the waterfall failed -> retry;
                              if BYOK, check your provider key.
  provider_output_too_large 502  -> lower max output tokens.
  gateway_draining 503        instance is draining -> retry (hits another).
  deadline_exceeded 504       request ran past the deadline -> shorten or retry.
  internal_error 500          -> retry with backoff.
Retry 429 (throttled)/502/503/504 with backoff. Do NOT blindly retry
400/401/403/409: fix the request first. Retries can double-bill a provider
(at-least-once); pass an Idempotency-Key to dedupe.

## Management API (same Bearer key; ${api}/api)

Catalog reads (keyless-public: public rows without a key, plus your org's own
rows when you send your key):
  GET  /api/models[?modality=&category=&provider=&min_context=&sort=&limit=&offset=]
  GET  /api/models/<slug>
  GET  /api/models/<slug>/providers
Custom and local models and waterfalls (the key acts for its own org):
  POST /api/models                      create a custom model: {slug, display_name,
                                        providers:[{provider, provider_model_id,
                                        base_url?, ...}]}
  POST /api/models/<slug>/providers     add a deployment or local variant
  GET/PUT /api/models/<slug>/waterfall  read or replace the ordered chain
                                        ({model_provider_ids:[...]})
BYOK provider connections:
  GET  /api/orgs/<org_id>/provider-connections
  PUT  /api/orgs/<org_id>/provider-connections/<provider>       connect/rotate
                                        ({secret, config})
  POST /api/orgs/<org_id>/provider-connections/<provider>/check verify
Usage and keys:
  GET  /api/gateway/usage/daily?org_id=&scope=&group_by=   rollup (day|model|member)
  GET  /api/gateway/usage/events?org_id=...                per-request stream
  GET  /api/gateway/catalog?org_id=...                     aliases as your org
                                        resolves them, with each one's lane
  GET  /api/keys                                           the org's keys (never
                                        secrets)
Archived Projects:
  The trace-backed optimizer, router-building, and Project-serving surfaces are
  retained for historical data and operator recovery only. Their UI routes and
  customer-key build paths are closed; do not use them as an inference API or
  as an alternate modeling implementation.
Trace telemetry (bring your traces in as telemetry only; never a router build;
the key acts for its org):
  POST /api/orgs/<org_id>/telemetry/traces/pull   live pull from a provider:
                                        {transport_kind, source_kind,
                                        source_label, credential, config?}.
                                        transport_kind is one of: braintrust,
                                        langsmith, langfuse, posthog, mastra,
                                        postgres. The credential is used once and
                                        never stored on the row.
  POST /api/orgs/<org_id>/telemetry/traces/upload  JSON {source_kind,
                                        source_label} returns a short-lived
                                        signed Storage URL/token (PUT exact raw
                                        bytes; 2h; path-bound; no overwrite).
  POST /api/orgs/<org_id>/telemetry/traces/<ingest_id>/finalize
                                        idempotent 202 accepted; the worker
                                        verifies the object then projects.
                                        Same formats and <=50MB as before.
                                        Arize/Phoenix have no live pull yet — use
                                        this with source_kind phoenix (or otlp).
  GET  /api/orgs/<org_id>/telemetry/traces   the org's landed telemetry traces
                                        plus total_ingests and total_traces (the
                                        verify-count). Humans see these at
                                        ${web}/telemetry. This path never creates
                                        a Project, preparation, or optimize job.
Providers accepted on a deployment: openai, anthropic, gemini,
azure_openai, openrouter, bedrock, local, fireworks, modal, experiential_cloud.
Experiential Cloud is a curated collection of models, hosted and optimized by
Experiential Labs. Call it with an xpl_ key. Organizations do not connect
their own credentials to it. BYOK connections stay: openai, anthropic, gemini,
azure_openai, openrouter, bedrock, fireworks, modal.

## Coding agents (Claude Code, Conductor, Codex, OpenCode, Cline, and any
## OpenAI-compatible tool)

Any coding agent that can target an OpenAI-compatible endpoint works against
this gateway: set its base URL to ${api}/v1, supply an xpl_ key as the Bearer
token, and name models by slug (from GET ${api}/v1/models). Tools that read
the standard OpenAI SDK environment variables need only:
  export OPENAI_BASE_URL="${api}/v1"
  export OPENAI_API_KEY="xpl_..."
Claude Code connects through the Anthropic Messages lane:
  export ANTHROPIC_BASE_URL="${api}"
  export ANTHROPIC_AUTH_TOKEN="xpl_..."
  export ANTHROPIC_MODEL="<slug>"
Any catalog slug works as the model, not just Claude models. See the
/v1/messages limits above (no extended thinking, no images).
Conductor (parallel Claude Code agents) uses the same variables in its
Settings -> Environment (Claude Code section), or per-repo in
.conductor/settings.local.toml under [environment_variables]; additionally set
ANTHROPIC_API_KEY to the EMPTY string there so Claude Code never tries to
authenticate with Anthropic directly.
Verified per-agent configs (Claude Code, OpenAI Codex CLI over the Responses
API, OpenCode, Cline) are maintained at ${web}/docs/coding-agents.

## Self-hosted CLI

Self-hosters run the open-source Experiential gateway from the terminal with
"exp run". The hosted platform manages the catalog, keys, and usage for you in
the web app.

## Typical agent flow

1. A human signs in and mints an API key at ${web}/settings/api-keys, and (for
   the pass-through lane) connects provider keys at ${web}/settings.
2. The agent receives the key. It calls GET ${api}/v1/models to see callable
   slugs.
3. The agent calls POST ${api}/v1/chat/completions (or /v1/responses) with
   model="<slug>" exactly as it would call OpenAI, streaming or not.
4. The agent reads its own usage and spend at
   GET ${api}/api/gateway/usage/daily; humans see the same at ${web}/telemetry
   and ${web}/credits.

## Setup prompts (paste one into a coding agent; it does the setup for you)

These are the same first-person prompts the web app's onboarding uses, with this
deployment's URLs already filled in. A human pastes one into a CLI coding agent;
the agent follows it literally. Human-readable copies: ${web}/docs/setup-prompts.
Shareable source copies: ${SETUP_PROMPTS_REPO_URL}.

${setupPrompts}

## Web app URL map (where to send a human)

  ${web}/                     sign in, then land on your key and credits
  ${web}/models               the catalog: search, detail, compare
  ${web}/playground           chat with any model in the browser
  ${web}/settings/api-keys    mint and revoke API keys
  ${web}/settings             connect BYOK provider keys
  ${web}/credits              balance, spend, and adding credits
  ${web}/telemetry            usage by model and by agent
`;
}
