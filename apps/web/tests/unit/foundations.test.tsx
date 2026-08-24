import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button, buttonClassName } from "@/components/ui/Button";
import { modelsPath, settingsPath } from "@/lib/routes";
import { readSseData } from "@/lib/sse";
import { parseTraceIngestEvent } from "@/lib/trace-ingest";

afterEach(() => {
  cleanup();
});

describe("routes", () => {
  it("builds the root-level URL scheme (no org segment)", () => {
    expect(modelsPath()).toBe("/models");
    expect(settingsPath()).toBe("/settings");
  });
});

describe("Button", () => {
  it("keeps the legacy variants' rendering contract", () => {
    render(
      <>
        <Button>default</Button>
        <Button variant="primary">primary</Button>
      </>
    );
    expect(screen.getByRole("button", { name: "default" }).className).toContain("bg-surface");
    expect(screen.getByRole("button", { name: "primary" }).className).toContain("bg-ink");
  });

  it("supports ghost and destructive variants and the sm size", () => {
    expect(buttonClassName("ghost")).toContain("bg-transparent");
    expect(buttonClassName("destructive")).toContain("text-red-600");
    expect(buttonClassName("default", undefined, "sm")).toContain("min-h-[30px]");
  });

  it("disables itself and shows a spinner while loading", () => {
    render(<Button loading>saving</Button>);
    const button = screen.getByRole("button", { name: "saving" });
    expect(button).toBeDisabled();
    expect(screen.getByTestId("button-spinner")).toBeInTheDocument();
  });
});

describe("trace ingest contract", () => {
  it("parses every event variant", () => {
    expect(parseTraceIngestEvent('{"type":"detected","format":"chat-json","traces":12}')).toEqual({
      type: "detected",
      format: "chat-json",
      traces: 12
    });
    expect(
      parseTraceIngestEvent('{"type":"progress","normalized":5,"total":null,"note":"batch 1"}')
    ).toEqual({ type: "progress", normalized: 5, total: null, note: "batch 1" });
    expect(
      parseTraceIngestEvent('{"type":"done","traces":12,"steps":140,"otel_object":"traces/x.jsonl"}')
    ).toEqual({ type: "done", traces: 12, steps: 140, otel_object: "traces/x.jsonl" });
    expect(parseTraceIngestEvent('{"type":"error","message":"boom"}')).toEqual({
      type: "error",
      message: "boom"
    });
  });

  it("returns null for malformed payloads instead of guessing", () => {
    expect(parseTraceIngestEvent("not json")).toBeNull();
    expect(parseTraceIngestEvent('{"type":"detected"}')).toBeNull();
    expect(parseTraceIngestEvent('{"type":"mystery","x":1}')).toBeNull();
    expect(parseTraceIngestEvent('{"type":"progress","normalized":"5","total":null}')).toBeNull();
  });

  it("composes with the shared SSE reader", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"progress","normalized":1,"total":2}\n\n')
        );
        controller.close();
      }
    });
    const events = [];
    for await (const payload of readSseData(body)) {
      events.push(parseTraceIngestEvent(payload));
    }
    expect(events).toEqual([{ type: "progress", normalized: 1, total: 2 }]);
  });
});
