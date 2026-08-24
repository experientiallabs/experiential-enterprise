// The per-trace-source "transfer prompt": the copy-paste block a customer
// drops into their own coding agent to gather the credential ONE observability
// source needs. It is the trace-source sibling of provider-transfer-prompt.ts,
// shown in the same ConnectModal shell. One deliberate difference: trace
// connections are managed through the session-authenticated web app only (the
// public API exposes no trace-connection upsert), so the agent's job here is
// to FIND the credential in the customer's own project and hand it back by
// prefix — never to print it in full and never to call an endpoint. Written
// first person: the human pastes it, so it IS their instruction and consent.

import { connectionKindLabel } from "@/lib/trace-ingest";

/** What the agent must locate for one connection kind, in plain words. */
type TraceSourceDetail = {
  /** One or more sentences naming precisely what to find and where it lives. */
  gather: string;
  /** An optional trailing note (a host rule, a key-shape hint). */
  note: string | null;
};

/** Exhaustive gather/note per managed trace-connection kind. */
function traceSourceDetail(kind: string): TraceSourceDetail {
  switch (kind) {
    case "phoenix":
      return {
        gather:
          "My Arize Phoenix API key. Look for PHOENIX_API_KEY (or PHOENIX_CLIENT_HEADERS) in " +
          "this project's env files or deployment config; it is also under Settings in my " +
          "Phoenix instance.",
        note: "If my Phoenix is self-hosted, also note its base URL for the host field."
      };
    case "langfuse":
      return {
        gather:
          "My Langfuse SECRET key (starts sk-lf-…). Look for LANGFUSE_SECRET_KEY in this " +
          "project's env files; it is also at cloud.langfuse.com under Project Settings, " +
          "API Keys.",
        note:
          "If LANGFUSE_HOST is set to something other than cloud.langfuse.com, also note it " +
          "for the host field."
      };
    case "langsmith":
      return {
        gather:
          "My LangSmith API key (starts lsv2_…). Look for LANGSMITH_API_KEY or " +
          "LANGCHAIN_API_KEY in this project's env files; it is also at smith.langchain.com " +
          "under Settings, API Keys.",
        note: null
      };
    case "braintrust":
      return {
        gather:
          "My Braintrust API key. Look for BRAINTRUST_API_KEY in this project's env files; " +
          "it is also at braintrust.dev under Settings, API Keys.",
        note: null
      };
    case "posthog":
      return {
        gather:
          "My PostHog PERSONAL API key (starts phx_…), not the phc_… project key. Look for " +
          "POSTHOG_PERSONAL_API_KEY in this project's env files; it is also under my PostHog " +
          "account settings, Personal API Keys.",
        note:
          "Also note which region my project lives in (us.posthog.com or eu.posthog.com) " +
          "for the host field."
      };
    case "mastra":
      return {
        gather:
          "My Mastra API key. Look for MASTRA_API_KEY in this project's env files or the " +
          "Mastra Cloud dashboard.",
        note: "If my Mastra instance is self-hosted, also note its base URL for the host field."
      };
    case "postgres":
      return {
        gather:
          "The Postgres DSN of the database my traces live in " +
          "(postgresql://user:pass@host:5432/db). Look for DATABASE_URL or POSTGRES_URL in " +
          "this project's env files.",
        note:
          "The DSN needs read access to the trace table only; a read-only role is the right " +
          "credential to hand over."
      };
    default:
      return {
        gather: `My ${connectionKindLabel(kind)} API credential, from this project's env files or the vendor's dashboard.`,
        note: null
      };
  }
}

/**
 * Build the paste-able gather prompt for one trace source.
 *
 * @param kind - The managed trace-connection kind (langfuse, posthog, postgres, …).
 * @param webBaseUrl - Public web origin (where the credential gets pasted); trailing slashes trimmed.
 * @returns The first-person prompt text, ready to copy.
 */
export function buildTraceSourceTransferPrompt(kind: string, webBaseUrl: string): string {
  const web = webBaseUrl.replace(/\/+$/, "");
  const label = connectionKindLabel(kind);
  const detail = traceSourceDetail(kind);
  const noteBlock = detail.note === null ? "" : `\n   ${detail.note}`;
  return `I pasted this into you myself, so help me connect ${label} as a trace source for my
Experiential Labs organization: imports can then pull my traces directly instead of
file uploads. This is my consent to gather the credential.

1. Find the credential.
   ${detail.gather}${noteBlock}

2. Report back by PREFIX ONLY (the first 8 characters), never the full value, and
   tell me exactly where you found it.

3. I will paste it myself at ${web}/settings/connections under Trace sources
   (${label}). Credentials are stored in Vault and never shown again.

Never echo the full credential anywhere: not in chat, not in a file, not in a log.`;
}
