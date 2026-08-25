// The "upload my traces as telemetry" prompt. A founder pastes this into their
// CLI coding agent; the agent creates the account HANDS-OFF via instant signup
// (it asks the founder for their email and POSTs it — no browser, no
// device code, no password), then INTERVIEWS the founder about which
// observability provider or database their LLM traces live in and branches
// accordingly — a live pull for the providers Platform can pull directly
// (Braintrust, LangSmith, Langfuse, PostHog, Mastra, or a Postgres database),
// or a file upload for an export (raw OTLP/OTel, Arize/Phoenix, or a plain chat
// transcript). Whatever the source, the traces land as ORGANIZATION TELEMETRY
// only: this flow never creates a Project, never prepares traces, and never
// trains a router. Building an optimized router from traces is a separate,
// deliberate dashboard action.
//
// The account is created UNVERIFIED, which is the point of "maximally
// frictionless": traces land with zero human steps, and the credit grant simply
// stays locked (the gateway refuses credit-drawing calls, migration
// 20260822150000 / P1025) until the founder clicks the verification email —
// asynchronous, and not needed to see their telemetry.
//
// First person and imperative by design (the founder pastes it, so it IS their
// instruction and consent): the agent follows it literally and never invents a
// credential, a file, or an endpoint. Every call after signup uses the
// EXPLABS_API_KEY (an `xpl_` org key) as the bearer token; the ingestion and
// verify reads are exactly the org-scoped routes the api-key edge allowlist
// admits at user strength (explabs/api/app.py `_CUSTOMER_KEY_ROUTES`).

import { buildInstantSignupSteps } from "@/components/account-creation/setup-prompt";

// Providers Platform can PULL live over the API, keyed by the exact
// `transport_kind` the pull route accepts. Kept in sync with the backend
// `TraceTransportKind` enum (explabs/trace_acquisition/connectors.py).
export const TRACE_PULL_TRANSPORTS = [
  "braintrust",
  "langsmith",
  "langfuse",
  "posthog",
  "mastra",
  "postgres"
] as const;

// Formats Platform accepts as a direct file upload, keyed by the exact
// `source_kind` the upload route accepts. Kept in sync with the backend
// `TraceUploadFormat` enum (explabs/trace_acquisition/formats.py). Providers
// without a live connector yet (Arize/Phoenix) ride the upload path via their
// exported file (phoenix), as does any raw OpenTelemetry export (otlp,
// otel-genai) or plain transcript (chat-json).
export const TRACE_UPLOAD_FORMATS = [
  "otlp",
  "otel-genai",
  "phoenix",
  "braintrust",
  "langfuse",
  "langsmith",
  "mastra",
  "posthog",
  "chat-json"
] as const;

/**
 * Build the paste-able "traces -> telemetry" onboarding prompt.
 *
 * @param webBaseUrl - Public web origin (dashboard + sign-in/verification).
 * @param apiBaseUrl - Public API base URL (signup + control endpoints live
 *   under `${apiBaseUrl}/api`, OpenAI clients use `${apiBaseUrl}/v1`).
 * @returns The first-person prompt text.
 */
export function buildTraceTelemetryPrompt(webBaseUrl: string, apiBaseUrl: string): string {
  const web = webBaseUrl.replace(/\/+$/, "");
  const api = apiBaseUrl.replace(/\/+$/, "");
  const pullTransports = TRACE_PULL_TRANSPORTS.join(", ");
  const uploadFormats = TRACE_UPLOAD_FORMATS.join(", ");
  return `I pasted this into you myself, please create an Experiential Labs account for
me and then pull my existing LLM traces onto the platform as telemetry. This is
my consent to create the account under my identity (using the email I give you
when you ask), to read my own trace files, and to use the observability
credential I give you. No browser step is needed to start, my account is
created instantly from my email; I only verify that email later to unlock my
credits, and I don't need to for my traces to land.

This uploads my existing traces so I can see them as telemetry on the platform.

Do it in this order. Print what you're doing at each step. If you lack a
capability (no network, no file access) or get stuck, stop and tell me exactly
what to do manually. Never invent an email, an API key, a credential, or a file
path, if you don't have one, ask me.

${buildInstantSignupSteps(web, api)}

Now bring my traces in as telemetry. Use EXPLABS_API_KEY (the xpl_ key from
step 2) as the bearer token on every call below. org_id is from step 2.

5. Interview me: where do my LLM traces live? Ask me one clear question and wait
   for my answer. Map my answer to exactly one path:
   - A supported observability provider or database Platform can pull directly
     (transport_kind one of: ${pullTransports}) -> go to step 6 (live pull).
   - An exported trace FILE on disk, a raw OpenTelemetry/OTLP export, an
     Arize/Phoenix export, or any of these upload formats
     (source_kind one of: ${uploadFormats}) -> go to step 7 (file upload).
   If I'm on Arize or Phoenix, there's no live pull yet: ask me to export my
   traces to a file and take the upload path with source_kind "phoenix" (or
   "otlp" for a raw OpenTelemetry export). If I name a provider that isn't in
   either list, tell me and offer the file-upload path. Only follow the ONE
   path that matches my answer.

6. Live pull path, connect the provider and pull. Ask me for the credential
   for the provider I named (for Braintrust an API key; for LangSmith/Langfuse
   their API key; for a Postgres database a DSN), plus the small bits of config
   that provider needs (e.g. Braintrust: the project name; LangSmith/Langfuse:
   optionally the project/host; Postgres: the table). Then:
   POST ${api}/api/orgs/<org_id>/telemetry/traces/pull
   Header: Authorization: Bearer $EXPLABS_API_KEY, Content-Type: application/json
   Body: {"transport_kind": "<one of ${pullTransports}>",
          "source_kind": "<the matching format, e.g. braintrust>",
          "source_label": "<a short label, NOT a path, e.g. braintrust-prod>",
          "credential": "<the secret you asked me for>",
          "config": {"project": "<my project>"}}
   The credential is used once to pull and is not echoed back. On 201 the
   response is {"ingest_id", "trace_count", "byte_size", "sha256", ...} , 
   capture trace_count and show it to me. A 400 means bad credentials or config
   (tell me exactly what it said); 429 means the provider rate-limited us (wait
   and retry). Then go to step 8.
   Example (Braintrust):
     curl -sS -X POST ${api}/api/orgs/<org_id>/telemetry/traces/pull \\
       -H "Authorization: Bearer $EXPLABS_API_KEY" \\
       -H "Content-Type: application/json" \\
       -d '{"transport_kind":"braintrust","source_kind":"braintrust",
            "source_label":"braintrust-prod","credential":"<my braintrust key>",
            "config":{"project":"<my braintrust project>"}}'

7. File upload path, find my trace export and upload it. I'm authorizing you to
   look for my own trace exports: search the current project, ./traces, ./logs,
   ./data, and my common cache/config paths for JSON or JSONL files that hold
   LLM/agent spans or runs (names like traces.jsonl, *.otel.jsonl, spans.json,
   otlp*.json). Show me the candidate files (path + size) and which format each
   looks like before you upload anything, and map each to ONE source_kind from:
   ${uploadFormats}
   (raw OpenTelemetry GenAI spans -> otel-genai; a raw OTLP export -> otlp; an
   Arize/Phoenix export -> phoenix; a vendor export -> its own name; a plain
   chat transcript -> chat-json). The file must be UTF-8 JSON or JSONL and at
   most 50 MB. Then do this three-step upload (do not POST the file through the
   API, that legacy multipart contract is gone):
   1. POST ${api}/api/orgs/<org_id>/telemetry/traces/upload
      Header: Authorization: Bearer $EXPLABS_API_KEY, Content-Type: application/json
      Body: {"source_kind":"<the format you chose>",
             "source_label":"<a short label, NOT a path, e.g. prod-otel-august>"}
      On 201 the response is {"ingest_id","signed_url","token","expires_in","method"}.
      It never contains service credentials or a writable path you can change.
   2. PUT the exact raw file bytes to signed_url (Content-Type:
      application/octet-stream). Do not wrap them as multipart.
   3. POST ${api}/api/orgs/<org_id>/telemetry/traces/<ingest_id>/finalize
      Header: Authorization: Bearer $EXPLABS_API_KEY
      On 202 the ingest is accepted; the worker verifies the stored bytes
      (existence, size, format, SHA-256) and projects them. Poll step 8 until
      status is done (or error). A 422 means the label failed validation.
   Example:
     TICKET=$(curl -sS -X POST ${api}/api/orgs/<org_id>/telemetry/traces/upload \\
       -H "Authorization: Bearer $EXPLABS_API_KEY" \\
       -H "Content-Type: application/json" \\
       -d '{"source_kind":"otlp","source_label":"prod-otel-august"}')
     curl -sS -X PUT "$(echo "$TICKET" | jq -r .signed_url)" \\
       -H "Content-Type: application/octet-stream" \\
       --data-binary @<path to my trace file>
     curl -sS -X POST ${api}/api/orgs/<org_id>/telemetry/traces/$(echo "$TICKET" | jq -r .ingest_id)/finalize \\
       -H "Authorization: Bearer $EXPLABS_API_KEY"

8. Verify the traces landed as telemetry.
   GET ${api}/api/orgs/<org_id>/telemetry/traces
   Header: Authorization: Bearer $EXPLABS_API_KEY
   -> 200 with {"traces": [...], "total_ingests", "total_traces"}. Confirm
   total_traces is greater than zero and matches the trace_count you captured,
   and that my ingest is in the list. Tell me the number.

When you're done, report back to me: my org_id, whether you pulled live or
uploaded a file (and from which provider/format), the ingest_id and its
trace_count, and the total_traces the verify read returned. My traces are now
telemetry on the platform. I can see them in my dashboard at ${web}/telemetry,
and the machine-readable contract is ${web}/llms.txt.

One last thing to tell me, then you're done: check my email inbox for a message
from Experiential Labs and click the verification link (or enter the code at
${web}/signin) to confirm my email. That's the ONLY thing left for me to do, and
it just unlocks my credits for paid model calls, my traces are already live and
don't need it. Until I verify, credit-drawing model calls are refused with
"insufficient_quota"; using my own provider keys (BYOK) is unaffected.`;
}
