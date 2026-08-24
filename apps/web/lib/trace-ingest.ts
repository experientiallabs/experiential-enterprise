// The streaming trace-ingest contract (D-INGEST in the coordination log,
// renegotiated 2026-07-23). The backend capability lives in the
// Experiential engine (`exp` trace ingestion) and is wrapped by the explabs
// endpoints: POST /api/orgs/{org_id}/trace-ingests
// (multipart: a `source` JSON part plus the file part for file sources) then
// SSE at GET /api/trace-ingests/{ingest_id}/stream.
// Changing this shape means renegotiating in the coordination log first.

export const TRACE_INGEST_PROVIDERS = [
  "phoenix",
  "langfuse",
  "langsmith",
  "braintrust",
  "posthog",
  "mastra"
] as const;

export type TraceIngestProvider = (typeof TRACE_INGEST_PROVIDERS)[number];

// Customer-facing labels for every managed trace-connection kind: the
// observability providers above plus the database connection. One vocabulary
// for the whole product, so the Settings integrations panel and the
// simulations source chip cannot drift apart.
const CONNECTION_KIND_LABELS: Record<string, string> = {
  phoenix: "Arize Phoenix",
  langfuse: "Langfuse",
  langsmith: "LangSmith",
  braintrust: "Braintrust",
  posthog: "PostHog",
  mastra: "Mastra",
  postgres: "Postgres database"
};

/** Label one stored connection kind; an unknown kind renders as itself. */
export function connectionKindLabel(kind: string): string {
  return CONNECTION_KIND_LABELS[kind] ?? kind;
}

// Credential fields (api_key, dsn) are write-only: sent in the POST, stored
// server-side as an org connection, and never echoed back in any response or
// event. Omitting them reuses the org's stored connection for that provider.
export type TraceIngestSource =
  | { kind: "file"; filename: string }
  | {
      kind: "database";
      engine: "postgres";
      table: string;
      dsn?: string;
      trace_id_column?: string;
      payload_column?: string;
      order_column?: string;
    }
  | {
      kind: "provider";
      provider: TraceIngestProvider;
      api_key?: string;
      project?: string;
      host?: string;
    };

export type TraceIngestErrorCode =
  | "bad_credentials"
  | "unreachable"
  | "bad_format"
  | "empty"
  | "internal";

export type TraceIngestEvent =
  | { type: "detected"; format: string; traces: number }
  | { type: "progress"; normalized: number; total: number | null; note?: string }
  | {
      type: "done";
      traces: number;
      steps: number;
      otel_object: string;
      trace_upload_id?: string;
    }
  | { type: "error"; message: string; code?: TraceIngestErrorCode };

const EVENT_TYPES = new Set(["detected", "progress", "done", "error"]);

const ERROR_CODES = new Set<string>([
  "bad_credentials",
  "unreachable",
  "bad_format",
  "empty",
  "internal"
]);

/**
 * Validate one SSE payload into a typed ingest event; returns null for
 * payloads that are not ingest events so callers can fail loudly with
 * context. Field presence is checked per variant; extra fields are ignored.
 */
export function parseTraceIngestEvent(payload: string): TraceIngestEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const event = raw as Record<string, unknown>;
  if (typeof event.type !== "string" || !EVENT_TYPES.has(event.type)) {
    return null;
  }
  switch (event.type) {
    case "detected":
      return typeof event.format === "string" && typeof event.traces === "number"
        ? { type: "detected", format: event.format, traces: event.traces }
        : null;
    case "progress":
      return typeof event.normalized === "number" &&
        (typeof event.total === "number" || event.total === null)
        ? {
            type: "progress",
            normalized: event.normalized,
            total: event.total,
            ...(typeof event.note === "string" ? { note: event.note } : {})
          }
        : null;
    case "done":
      return typeof event.traces === "number" &&
        typeof event.steps === "number" &&
        typeof event.otel_object === "string"
        ? {
            type: "done",
            traces: event.traces,
            steps: event.steps,
            otel_object: event.otel_object,
            ...(typeof event.trace_upload_id === "string"
              ? { trace_upload_id: event.trace_upload_id }
              : {})
          }
        : null;
    default:
      return typeof event.message === "string"
        ? {
            type: "error",
            message: event.message,
            ...(typeof event.code === "string" && ERROR_CODES.has(event.code)
              ? { code: event.code as TraceIngestErrorCode }
              : {})
          }
        : null;
  }
}
