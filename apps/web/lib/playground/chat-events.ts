// The playground chat transport's wire vocabulary, shared by the server route
// that emits it and the client that consumes it. The route relays the
// gateway's streamed completion as these events; the browser cannot POST an
// EventSource, so the client reads the fetch body through lib/sse and narrows
// each payload here. One module owns the shape so producer and consumer can
// never disagree about a field.

/** One streamed event from POST /api/playground/chat. */
export type PlaygroundChatEvent =
  | { type: "delta"; text: string }
  | {
      type: "usage";
      promptTokens: number | null;
      completionTokens: number | null;
      latencyMs: number;
    }
  | { type: "error"; message: string }
  | { type: "done" };

/** Narrow one SSE `data:` payload into a typed event, or null if malformed. */
export function parsePlaygroundChatEvent(payload: string): PlaygroundChatEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const type = (data as { type?: unknown }).type;
  switch (type) {
    case "delta": {
      const text = (data as { text?: unknown }).text;
      return typeof text === "string" ? { type: "delta", text } : null;
    }
    case "usage": {
      const record = data as {
        promptTokens?: unknown;
        completionTokens?: unknown;
        latencyMs?: unknown;
      };
      const latencyMs = record.latencyMs;
      if (typeof latencyMs !== "number") {
        return null;
      }
      return {
        type: "usage",
        promptTokens: typeof record.promptTokens === "number" ? record.promptTokens : null,
        completionTokens:
          typeof record.completionTokens === "number" ? record.completionTokens : null,
        latencyMs
      };
    }
    case "error": {
      const message = (data as { message?: unknown }).message;
      return typeof message === "string" ? { type: "error", message } : null;
    }
    case "done":
      return { type: "done" };
    default:
      return null;
  }
}
