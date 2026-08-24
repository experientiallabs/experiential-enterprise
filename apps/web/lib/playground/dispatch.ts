// The playground's client-side dispatch: POST one turn to the gateway-backed
// chat route and yield its streamed events. Lifted out of PlaygroundChat so the
// SAME serving path can be driven once per pane (the multi-model board fans one
// prompt out across N panes, each calling this independently), and so the
// fan-out is mockable at a single seam in tests. There is still ONE serving
// lane: /api/playground/chat mints a short-lived org key and streams the real
// /v1 completion; this module does not invent a second one.

import { parsePlaygroundChatEvent, type PlaygroundChatEvent } from "@/lib/playground/chat-events";
import { readSseData } from "@/lib/sse";

/** The body POST /api/playground/chat accepts, one pane's worth. */
export type PlaygroundChatRequest = {
  model: string;
  orgId: string;
  messages: Array<{ role: string; content: unknown }>;
  params: Record<string, unknown>;
};

/** POST one turn and yield the streamed events for a single pane. */
export async function* streamPlaygroundChat(
  body: PlaygroundChatRequest,
  signal: AbortSignal
): AsyncGenerator<PlaygroundChatEvent> {
  const response = await fetch("/api/playground/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok || response.body === null) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    yield {
      type: "error",
      message:
        typeof payload?.error === "string"
          ? payload.error
          : "The model could not serve this request."
    };
    return;
  }
  for await (const payload of readSseData(response.body)) {
    const event = parsePlaygroundChatEvent(payload);
    if (event !== null) {
      yield event;
    }
  }
}
