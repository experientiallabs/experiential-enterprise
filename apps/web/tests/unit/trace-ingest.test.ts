import { describe, expect, it } from "vitest";

import { parseTraceIngestEvent } from "@/lib/trace-ingest";

// Real event lines captured from the wmh backend (`wmh ingest --json`, the same
// `event_json` serialization the explabs SSE endpoint streams): a tau-bench file
// ingest, a Postgres session-table ingest, and live failure paths (wrong
// password, missing table). The pinned parser must accept every one of them.
const REAL_BACKEND_EVENTS = [
  '{"type": "detected", "format": "otel-genai", "traces": 1033}',
  '{"type": "detected", "format": "postgres", "traces": 2}',
  '{"type": "progress", "normalized": 1, "total": 2}',
  '{"type": "progress", "normalized": 2, "total": 2, "note": "wrote 5 spans"}',
  '{"type": "done", "traces": 2, "steps": 3, "otel_object": "/tmp/pg_messages.otel.jsonl"}',
  '{"type": "error", "message": "postgres authentication failed: connection failed", "code": "bad_credentials"}',
  '{"type": "error", "message": "postgres table \'no_such_table\' does not exist; check --table (schema-qualify it if needed, e.g. public.agent_traces)", "code": "bad_format"}'
];

describe("parseTraceIngestEvent", () => {
  it("accepts every real backend event payload", () => {
    for (const payload of REAL_BACKEND_EVENTS) {
      const event = parseTraceIngestEvent(payload);
      expect(event, payload).not.toBeNull();
    }
  });

  it("parses the renegotiated optional fields", () => {
    const done = parseTraceIngestEvent(
      '{"type": "done", "traces": 1, "steps": 2, "otel_object": "ingests/o/i.otel.jsonl", "trace_upload_id": "tu-1"}'
    );
    expect(done).toEqual({
      type: "done",
      traces: 1,
      steps: 2,
      otel_object: "ingests/o/i.otel.jsonl",
      trace_upload_id: "tu-1"
    });

    const error = parseTraceIngestEvent('{"type": "error", "message": "no", "code": "unreachable"}');
    expect(error).toEqual({ type: "error", message: "no", code: "unreachable" });

    // Pre-renegotiation payloads (no code, no trace_upload_id) still parse.
    expect(parseTraceIngestEvent('{"type": "error", "message": "boom"}')).toEqual({
      type: "error",
      message: "boom"
    });
  });

  it("keeps null totals and drops unknown error codes rather than failing", () => {
    expect(parseTraceIngestEvent('{"type": "progress", "normalized": 3, "total": null}')).toEqual({
      type: "progress",
      normalized: 3,
      total: null
    });
    expect(parseTraceIngestEvent('{"type": "error", "message": "m", "code": "not-a-code"}')).toEqual(
      { type: "error", message: "m" }
    );
  });

  it("rejects non-events loudly (null) so consumers can fail with context", () => {
    expect(parseTraceIngestEvent("not json")).toBeNull();
    expect(parseTraceIngestEvent('{"type": "unknown"}')).toBeNull();
    expect(parseTraceIngestEvent('{"type": "progress", "normalized": 1}')).toBeNull(); // total absent
    expect(parseTraceIngestEvent('{"type": "done", "traces": 1, "steps": 2}')).toBeNull();
  });
});

// The verbatim SSE byte stream captured from GET /api/trace-ingests/{id}/stream on a
// live stack (file ingest of a one-conversation chat.json), including framing. This is
// the exact pipeline a browser runs: bytes -> readSseData -> parseTraceIngestEvent.
const REAL_SSE_STREAM =
  'data: {"type": "detected", "format": "chat-json", "traces": 1}\n\n' +
  'data: {"type": "progress", "normalized": 1, "total": 1}\n\n' +
  'data: {"type": "progress", "normalized": 1, "total": 1, "note": "wrote 3 spans"}\n\n' +
  'data: {"type": "done", "traces": 1, "steps": 2, "otel_object": "ingests/00000000-0000-0000-0000-000000000001/ac171e5b-a927-4a6c-a2f8-b3b05756a1d6.otel.jsonl"}\n\n';

describe("end-to-end SSE parsing (readSseData + parseTraceIngestEvent)", () => {
  it("parses a real captured backend stream byte-for-byte", async () => {
    const { readSseData } = await import("@/lib/sse");
    const body = new Response(REAL_SSE_STREAM).body;
    expect(body).not.toBeNull();
    const events = [];
    for await (const payload of readSseData(body as ReadableStream<Uint8Array>)) {
      const event = parseTraceIngestEvent(payload);
      expect(event, payload).not.toBeNull();
      events.push(event);
    }
    expect(events.map((event) => event?.type)).toEqual([
      "detected",
      "progress",
      "progress",
      "done"
    ]);
    expect(events[0]).toEqual({ type: "detected", format: "chat-json", traces: 1 });
    const done = events.at(-1);
    expect(done?.type === "done" && done.otel_object.startsWith("ingests/")).toBe(true);
  });
});
