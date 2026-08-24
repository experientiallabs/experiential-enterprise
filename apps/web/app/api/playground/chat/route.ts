// The playground's chat transport: one streaming completion for any catalog
// model, served through the real gateway exactly like customer traffic. The
// selected model's catalog slug IS the /v1 model name. The route mints a
// short-lived org `xpl_` serving key server-side for the call and revokes it
// when the stream ends (see lib/playground/serving-key.ts), so the browser
// never holds a serving credential and the gateway edge sees real customer
// auth, not the deploy bearer. The upstream OpenAI stream is
// relayed as PlaygroundChatEvent SSE, with the gateway's own token usage and
// the measured latency emitted as a final `usage` event. There are no routers,
// endpoints, or sample models here — the gateway is the one serving lane.

import { requireOrgId } from "@/lib/auth/orgs";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import { jsonError, sseResponse } from "@/lib/http";
import type { PlaygroundChatEvent } from "@/lib/playground/chat-events";
import { mintPlaygroundServingKey } from "@/lib/playground/serving-key";
import { readSseData } from "@/lib/sse";

export const dynamic = "force-dynamic";

// Spend guards: playground calls meter against the org's real credits, so a
// conversation stays bounded well past any honest use but far below what a
// scripted co-tenant could burn per call.
const MAX_MESSAGES = 40;
const MAX_TOTAL_CONTENT_CHARS = 200_000;
const MAX_BODY_BYTES = 8_000_000;

/**
 * One chat message. Content is a plain string for text, or an array of
 * OpenAI content parts when the composer attaches an image or file. Parts are
 * forwarded verbatim; inline image/PDF serving is a pending engine capability,
 * so a multimodal message may not yet affect the reply (the UI flags this).
 */
type PlaygroundMessage = { role: string; content: string | unknown[] };

/** The request body POST /api/playground/chat accepts. */
type ChatRequestBody = {
  model?: unknown;
  orgId?: unknown;
  messages?: unknown;
  params?: unknown;
};

/** Count the character weight of a message's content for the size guard. */
function contentChars(content: string | unknown[]): number {
  return typeof content === "string" ? content.length : JSON.stringify(content).length;
}

/** Validate the raw messages into a bounded, typed list, or null if malformed. */
function parseMessages(raw: unknown): PlaygroundMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
    return null;
  }
  const parsed: PlaygroundMessage[] = [];
  let totalChars = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (typeof role !== "string") {
      return null;
    }
    if (typeof content !== "string" && !Array.isArray(content)) {
      return null;
    }
    totalChars += contentChars(content);
    if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
      return null;
    }
    parsed.push({ role, content });
  }
  return parsed;
}

// The serving params the playground forwards, by OpenAI name. The rail already
// validated these (lib/playground/model-params.ts); this is the defense-in-depth
// allowlist so an arbitrary key or oversized value never reaches the gateway.
function pickServingParams(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const source = raw as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  const temperature = source.temperature;
  if (typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    params.temperature = temperature;
  }
  const topP = source.top_p;
  if (typeof topP === "number" && Number.isFinite(topP) && topP >= 0 && topP <= 1) {
    params.top_p = topP;
  }
  const maxTokens = source.max_tokens;
  if (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 200_000) {
    params.max_tokens = maxTokens;
  }
  const reasoning = source.reasoning_effort;
  if (reasoning === "low" || reasoning === "medium" || reasoning === "high") {
    params.reasoning_effort = reasoning;
  }
  const seed = source.seed;
  if (typeof seed === "number" && Number.isInteger(seed)) {
    params.seed = seed;
  }
  const stop = source.stop;
  if (Array.isArray(stop) && stop.length <= 8 && stop.every((entry) => typeof entry === "string")) {
    params.stop = stop;
  }
  const tools = source.tools;
  if (Array.isArray(tools) && tools.length <= 64) {
    params.tools = tools;
    params.tool_choice = "auto";
  }
  const responseFormat = source.response_format;
  if (
    typeof responseFormat === "object" &&
    responseFormat !== null &&
    (responseFormat as { type?: unknown }).type === "json_object"
  ) {
    params.response_format = { type: "json_object" };
  }
  return params;
}

/** The subset of the streamed OpenAI chunk this route reads. */
type UpstreamChunk = {
  choices?: Array<{ delta?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
};

function parseChunk(payload: string): UpstreamChunk | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null ? (parsed as UpstreamChunk) : null;
  } catch {
    return null;
  }
}

async function upstreamErrorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown } | string;
  } | null;
  const error = payload?.error;
  if (typeof error === "string") {
    return error;
  }
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : "The model could not serve this request.";
}

export async function POST(request: Request): Promise<Response> {
  try {
    // Defense in depth alongside the proxy's blanket /api/* gate: this route
    // spends the org's real serving credits.
    const user = await getAuthenticatedUser();
    if (user === null) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    const body = (await request.json().catch(() => null)) as ChatRequestBody | null;
    const model = body?.model;
    if (typeof model !== "string" || model.trim() === "" || model.length > 200) {
      return Response.json({ error: "A model must be selected." }, { status: 400 });
    }
    const orgIdentifier = body?.orgId;
    if (typeof orgIdentifier !== "string" || orgIdentifier.trim() === "") {
      return Response.json({ error: "An organization is required." }, { status: 400 });
    }
    const messages = parseMessages(body?.messages);
    if (messages === null) {
      return Response.json({ error: "Malformed or oversized conversation." }, { status: 400 });
    }
    // Resolves the caller's canonical org and asserts membership; a foreign or
    // unknown org is a 404, indistinguishable from an absent one.
    const orgId = await requireOrgId(orgIdentifier);
    const params = pickServingParams(body?.params);

    // The gateway edge authenticates a customer `xpl_` key, not the deployment
    // bearer, so mint a short-lived org serving key for this exchange and
    // revoke it the moment the stream ends (below and on every early return).
    const servingKey = await mintPlaygroundServingKey(orgId, user.id);

    const startedAt = Date.now();
    let upstream: Response;
    try {
      upstream = await getDataSource().streamChatCompletion(
        servingKey.secret,
        {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...params
        },
        // Forward the browser's abort so an abandoned stream stops the upstream
        // (credit-spending) call; the gateway still meters the partial usage.
        request.signal
      );
    } catch (error) {
      await servingKey.revoke();
      throw error;
    }

    const encoder = new TextEncoder();
    const emit = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      event: PlaygroundChatEvent
    ) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (!upstream.ok || upstream.body === null) {
            emit(controller, { type: "error", message: await upstreamErrorMessage(upstream) });
            emit(controller, { type: "done" });
            return;
          }
          let promptTokens: number | null = null;
          let completionTokens: number | null = null;
          for await (const payload of readSseData(upstream.body)) {
            if (payload === "[DONE]") {
              break;
            }
            const chunk = parseChunk(payload);
            if (chunk === null) {
              continue;
            }
            for (const choice of chunk.choices ?? []) {
              const text = choice.delta?.content;
              if (typeof text === "string" && text.length > 0) {
                emit(controller, { type: "delta", text });
              }
            }
            const usage = chunk.usage;
            if (usage) {
              if (typeof usage.prompt_tokens === "number") {
                promptTokens = usage.prompt_tokens;
              }
              if (typeof usage.completion_tokens === "number") {
                completionTokens = usage.completion_tokens;
              }
            }
          }
          emit(controller, {
            type: "usage",
            promptTokens,
            completionTokens,
            latencyMs: Date.now() - startedAt
          });
          emit(controller, { type: "done" });
        } catch (error) {
          // A client disconnect aborts the upstream read; there is no consumer
          // left, so surface nothing. Any other mid-stream failure is reported
          // in-band since the response already started.
          if (!request.signal.aborted) {
            const message =
              error instanceof Error ? error.message : "The response could not be completed.";
            emit(controller, { type: "error", message });
            emit(controller, { type: "done" });
          }
        } finally {
          // The key exists only for this exchange: revoke it whether the stream
          // completed, errored, or the client disconnected mid-stream.
          await servingKey.revoke();
          controller.close();
        }
      }
    });
    return sseResponse(stream);
  } catch (error) {
    return jsonError(error);
  }
}
