// The per-provider "transfer prompt": the copy-paste block a customer drops
// into their own coding agent to connect ONE provider's account to their
// Experiential Labs gateway (BYOK pass-through). It is the single-provider,
// modal-scoped sibling of components/yc/setup-prompt.ts's
// buildConnectInferenceKeysStep — that step lists every provider generically;
// this one is curated per provider so the agent gathers exactly what THAT
// provider needs and makes the exact connect call, with the precise config the
// public API's ConnectionUpsertRequest validates (Azure endpoint + deployments,
// Bedrock access-key-id + region, Fireworks account id, Modal's token pair,
// everyone else a bare key). Written first person: the human pastes it, so it
// IS their instruction and consent, matching the YC and account-creation
// prompts. Base URLs flow through the same deployment-aware resolution the
// /llms.txt reference and the YC prompt use.

import { modelProviderLabel, type ModelProvider } from "@/lib/model-providers";

/** The provider-specific middle of the prompt: what to gather and the exact body. */
type ProviderTransferDetail = {
  /** One or more sentences naming precisely what the agent must collect. */
  gather: string;
  /** The exact JSON request body, already indented for the numbered step. */
  body: string;
  /** An optional trailing note (an admin key add-on, an at-least-one rule). */
  note: string | null;
};

/** Exhaustive per-provider gather/body/note over the ModelProvider union. */
function providerTransferDetail(provider: ModelProvider): ProviderTransferDetail {
  switch (provider) {
    case "openai":
      return {
        gather:
          "My OpenAI INFERENCE key (starts sk-… or sk-proj-…). Do NOT use an admin " +
          "key (sk-admin-…) here; that one cannot do inference. It is at " +
          "platform.openai.com/api-keys.",
        body: `{"secret": "<my OpenAI inference key>"}`,
        note:
          "If I also hand you my OpenAI ADMIN key (sk-admin-…), add " +
          '"spend_secret": "<my admin key>" to the same body so month-to-date spend shows.'
      };
    case "anthropic":
      return {
        gather:
          "My Anthropic INFERENCE key (starts sk-ant-api…). Do NOT use an admin key " +
          "(sk-ant-admin…) here; that one cannot do inference. It is at " +
          "console.anthropic.com/settings/keys.",
        body: `{"secret": "<my Anthropic inference key sk-ant-api…>"}`,
        note:
          "If I also hand you my Anthropic ADMIN key (sk-ant-admin…), add " +
          '"spend_secret": "<my admin key>" to the same body so month-to-date spend shows.'
      };
    case "gemini":
      return {
        gather:
          "My Google AI Studio API key (starts AIza…), created at " +
          "aistudio.google.com/apikey.",
        body: `{"secret": "<my AI Studio API key AIza…>"}`,
        note: null
      };
    case "openrouter":
      return {
        gather: "My OpenRouter API key (starts sk-or-v1-…), created at openrouter.ai/keys.",
        body: `{"secret": "<my OpenRouter key sk-or-v1-…>"}`,
        note: null
      };
    case "fireworks":
      return {
        gather:
          "Two things from fireworks.ai: my API key (starts fw_…), and my account id, " +
          "the account slug in my dashboard URL (fireworks.ai/account/<this-slug>), " +
          "which the key alone does not reveal.",
        body: `{
  "secret": "<my Fireworks key fw_…>",
  "config": { "account_id": "<my-fireworks-account-slug>" }
}`,
        note: null
      };
    case "azure_openai":
      return {
        gather:
          "From my Azure AI Foundry resource: the API key; the resource endpoint " +
          "(https://<my-resource>.openai.azure.com); optionally the API version " +
          '("v1" or a dated one like 2024-05-01-preview); and, for EACH catalog model I ' +
          "want served, the deployment name I created for it in that resource (Azure " +
          "routes by deployment name, not model id, so the key alone cannot route).",
        body: `{
  "secret": "<my Azure Foundry API key>",
  "config": {
    "endpoint": "https://<my-resource>.openai.azure.com",
    "api_version": "2024-05-01-preview",
    "deployments": { "gpt-5.5": "<my-gpt-5-5-deployment-name>" }
  }
}`,
        note:
          "At least one deployment mapping is required or the connection routes nothing. " +
          "api_version is optional; drop it to use the account default."
      };
    case "bedrock":
      return {
        gather:
          "From AWS: an access key id (starts AKIA…), its secret access key, and the " +
          "region Bedrock should run in (e.g. us-east-1). The secret access key is the " +
          "credential; the access key id and region are non-secret config.",
        body: `{
  "secret": "<my AWS secret access key>",
  "config": {
    "access_key_id": "<my AWS access key id AKIA…>",
    "region": "us-east-1"
  }
}`,
        note: null
      };
    case "modal":
      return {
        gather:
          "My Modal token PAIR: the token id (starts ak-…) and the token secret " +
          "(starts as-…), both from modal.com → Settings → API tokens (the secret is " +
          "shown once, at creation).",
        body: `{
  "secret": { "token_id": "<ak-…>", "token_secret": "<as-…>" }
}`,
        note: null
      };
    default: {
      // Exhaustiveness: a new BYOK provider must add its curated block above.
      const unreachable: never = provider;
      return unreachable;
    }
  }
}

/**
 * Build the paste-able connect prompt for one provider.
 *
 * @param provider - The BYOK provider this modal connects.
 * @param webBaseUrl - Public web origin (where I manage keys); trailing slashes trimmed.
 * @param apiBaseUrl - Public API base URL (`${api}/api/…`, `${api}/v1`); trailing slashes trimmed.
 * @returns The first-person prompt text, ready to copy.
 */
export function buildProviderTransferPrompt(
  provider: ModelProvider,
  webBaseUrl: string,
  apiBaseUrl: string
): string {
  const web = webBaseUrl.replace(/\/+$/, "");
  const api = apiBaseUrl.replace(/\/+$/, "");
  const label = modelProviderLabel(provider);
  const detail = providerTransferDetail(provider);
  const noteBlock = detail.note === null ? "" : `\n   ${detail.note}`;
  return `I pasted this into you myself, so connect my ${label} account to my Experiential Labs
gateway so my own ${label} traffic bills to my ${label} key (free pass-through, still
tracked in my credit and usage views). This is my consent to wire it up.

Use my Experiential Labs org key as the bearer token on every call below. It is a
secret: read it from the EXPLABS_API_KEY environment variable and never print it in
full. If it is not set, ask me for it (I can mint one at ${web}/settings/api-keys).

1. Find my org id.
   GET ${api}/api/whoami  with header Authorization: Bearer $EXPLABS_API_KEY
   Capture org_id from the response.

2. Gather what ${label} needs.
   ${detail.gather}

3. Connect it. Send exactly this, substituting the values from step 2:
   PUT ${api}/api/orgs/<org_id>/provider-connections/${provider}
   Authorization: Bearer $EXPLABS_API_KEY
   Content-Type: application/json
   ${detail.body}${noteBlock}

4. Read the verdict, do not guess it. The response body has check.status. Tell me
   that status. If it is not "valid", read check.status_detail.remediation and tell me
   exactly how to fix it, then stop, and do not retry blindly. Never echo my key or secret.

If you cannot do this, tell me what you gathered (by prefix only, never the full
value) and I will paste it at ${web}/credits myself; it is verified on save the same way.`;
}
