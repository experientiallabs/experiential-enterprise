import { afterEach, describe, expect, it, vi } from "vitest";

// The route verifies the session itself (it spends the org's serving credits);
// tests run authenticated by default and flip this to null for the 401 case.
const getAuthenticatedUser = vi.hoisted(() => vi.fn(async () => ({ id: "user-1" })));
vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));

// requireOrgId asserts the caller's membership and returns the canonical id.
const requireOrgId = vi.hoisted(() => vi.fn(async (identifier: string) => `org-${identifier}`));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));

// The one gateway call: the route hands it (servingKey, {model, messages,
// stream, ...params}) and relays the streamed completion. Tests supply a fake
// upstream stream.
const streamChatCompletion = vi.hoisted(() => vi.fn());
vi.mock("@/lib/data-source", () => ({ getDataSource: () => ({ streamChatCompletion }) }));

// The route mints a short-lived org serving key and revokes it when the stream
// ends; tests assert the minted secret reaches the gateway and revoke fires.
const revoke = vi.hoisted(() => vi.fn(async () => {}));
const mintPlaygroundServingKey = vi.hoisted(() =>
  vi.fn(async () => ({ secret: "xpl_minted_test_key", revoke }))
);
vi.mock("@/lib/playground/serving-key", () => ({ mintPlaygroundServingKey }));

import { readSseData } from "@/lib/sse";
import type { PlaygroundChatEvent } from "@/lib/playground/chat-events";

import { POST } from "@/app/api/playground/chat/route";

/** A ReadableStream emitting the given SSE text chunks, then closing. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

/** A fake gateway /v1 response carrying an OpenAI SSE completion. */
function upstreamOk(chunks: string[]): Response {
  return new Response(sseStream(chunks), { status: 200 });
}

async function collectEvents(response: Response): Promise<PlaygroundChatEvent[]> {
  if (response.body === null) {
    throw new Error("expected a streaming response body");
  }
  const events: PlaygroundChatEvent[] = [];
  for await (const payload of readSseData(response.body)) {
    events.push(JSON.parse(payload) as PlaygroundChatEvent);
  }
  return events;
}

function post(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/playground/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

afterEach(() => {
  vi.clearAllMocks();
  getAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrgId.mockImplementation(async (identifier: string) => `org-${identifier}`);
  mintPlaygroundServingKey.mockResolvedValue({ secret: "xpl_minted_test_key", revoke });
});

describe("POST /api/playground/chat", () => {
  it("returns 401 without a verified session, before any gateway call", async () => {
    getAuthenticatedUser.mockResolvedValueOnce(null as never);
    const response = await POST(
      post({ model: "gpt-5.6-sol", orgId: "acme", messages: [{ role: "user", content: "hi" }] })
    );
    expect(response.status).toBe(401);
    expect(streamChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects a missing model and a missing org", async () => {
    const noModel = await POST(
      post({ orgId: "acme", messages: [{ role: "user", content: "hi" }] })
    );
    expect(noModel.status).toBe(400);
    const noOrg = await POST(
      post({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] })
    );
    expect(noOrg.status).toBe(400);
    expect(streamChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects unbounded or oversized conversations before spending credits", async () => {
    const tooMany = await POST(
      post({
        model: "gpt-5.6-sol",
        orgId: "acme",
        messages: Array.from({ length: 41 }, () => ({ role: "user", content: "hi" }))
      })
    );
    expect(tooMany.status).toBe(400);
    const tooBig = await POST(
      post({ model: "gpt-5.6-sol", orgId: "acme", messages: [{ role: "user", content: "hi" }] }, {
        "content-length": "9000000"
      })
    );
    expect(tooBig.status).toBe(413);
    expect(streamChatCompletion).not.toHaveBeenCalled();
  });

  it("streams deltas and a final usage event through the gateway", async () => {
    streamChatCompletion.mockResolvedValueOnce(
      upstreamOk([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n"
      ])
    );
    const response = await POST(
      post({
        model: "gpt-5.6-sol",
        orgId: "acme",
        messages: [{ role: "user", content: "hi" }],
        params: { temperature: 0.4 }
      })
    );
    expect(response.status).toBe(200);
    const events = await collectEvents(response);
    expect(events.filter((event) => event.type === "delta").map((event) => (event as { text: string }).text)).toEqual([
      "Hel",
      "lo"
    ]);
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({ promptTokens: 11, completionTokens: 2 });
    expect((usage as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
    expect(events.at(-1)).toEqual({ type: "done" });

    // The gateway is called with the minted org serving key and the streaming
    // body, temperature forwarded, unknown params dropped.
    expect(mintPlaygroundServingKey).toHaveBeenCalledWith("org-acme", "user-1");
    const [servingKey, sentBody] = streamChatCompletion.mock.calls[0];
    expect(servingKey).toBe("xpl_minted_test_key");
    expect(sentBody).toMatchObject({
      model: "gpt-5.6-sol",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.4
    });
    // The ephemeral key is revoked once the stream drains.
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("drops params the allowlist does not recognize or that fall out of range", async () => {
    streamChatCompletion.mockResolvedValueOnce(upstreamOk(["data: [DONE]\n\n"]));
    await POST(
      post({
        model: "gpt-5.6-sol",
        orgId: "acme",
        messages: [{ role: "user", content: "hi" }],
        params: { temperature: 9, top_p: 0.5, made_up: "x", reasoning_effort: "high" }
      })
    );
    const [, sentBody] = streamChatCompletion.mock.calls[0];
    expect(sentBody).not.toHaveProperty("temperature"); // 9 is out of [0,2]
    expect(sentBody).not.toHaveProperty("made_up");
    expect(sentBody).toMatchObject({ top_p: 0.5, reasoning_effort: "high" });
  });

  it("surfaces an upstream gateway error in-band", async () => {
    streamChatCompletion.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 402 })
    );
    const response = await POST(
      post({ model: "gpt-5.6-sol", orgId: "acme", messages: [{ role: "user", content: "hi" }] })
    );
    const events = await collectEvents(response);
    expect(events[0]).toEqual({ type: "error", message: "insufficient credits" });
    expect(events.at(-1)).toEqual({ type: "done" });
    // The ephemeral key is revoked even when the upstream response is an error.
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("revokes the ephemeral key when the stream tears down mid-completion", async () => {
    // A client disconnect aborts the forwarded signal, so the upstream body
    // errors and the read loop throws into the stream's finally; simulate that
    // by erroring the upstream body after one delta. The key must not leak.
    const encoder = new TextEncoder();
    const torn = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
        controller.error(new Error("connection reset"));
      }
    });
    streamChatCompletion.mockResolvedValueOnce(new Response(torn, { status: 200 }));
    const response = await POST(
      post({ model: "gpt-5.6-sol", orgId: "acme", messages: [{ role: "user", content: "hi" }] })
    );
    // Draining may reject when the underlying stream errors; the revoke in the
    // route's finally is what this asserts, not the drain outcome.
    await collectEvents(response).catch(() => {});
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
