import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push })
}));

import { PlaygroundChat } from "@/components/playground/PlaygroundChat";
import { makeEntry } from "./models-catalog-fixtures";

// Playable entries: text output + at least one provider. Preferred rank puts
// them in the picker's always-open Recommended band, so add-model tests can
// click rows without expanding a provider group first.
const MODELS = [
  makeEntry({ id: "m-a", slug: "alpha", display_name: "Alpha", preferred_rank: 1 }, [{ id: "a-1" }]),
  makeEntry({ id: "m-b", slug: "bravo", display_name: "Bravo", preferred_rank: 2 }, [{ id: "b-1" }]),
  makeEntry({ id: "m-c", slug: "charlie", display_name: "Charlie", preferred_rank: 3 }, [
    { id: "c-1" }
  ]),
  makeEntry({ id: "m-d", slug: "delta", display_name: "Delta", preferred_rank: 4 }, [{ id: "d-1" }]),
  makeEntry({ id: "m-e", slug: "echo", display_name: "Echo", preferred_rank: 5 }, [{ id: "e-1" }])
];

/** An SSE playground-chat response streaming the given events. */
function sseResponse(events: object[]): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Streamed happy-path events: one delta, usage, done. */
function replyEvents(text: string): object[] {
  return [
    { type: "delta", text },
    { type: "usage", promptTokens: 10, completionTokens: 5, latencyMs: 120 },
    { type: "done" }
  ];
}

let replaceState: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/playground");
  replaceState = vi.spyOn(window.history, "replaceState");
});

function lastMirroredUrl(): string {
  const call = replaceState.mock.calls.at(-1);
  return String(call?.[2] ?? "");
}

function panes() {
  return screen.getAllByTestId("playground-pane");
}

describe("playground compare mode", () => {
  it("renders one pane per known model from a deep link, dropping unknown slugs", () => {
    render(
      <PlaygroundChat
        initialModelSlugs={["alpha", "bravo", "ghost"]}
        models={MODELS}
        orgId="org-1"
      />
    );
    expect(panes()).toHaveLength(2);
    expect(screen.getByText("Comparing 2 models. One prompt, every reply side by side.")).toBeTruthy();
    // The params rail is single-model only.
    expect(screen.queryByText("Parameters")).toBeNull();
  });

  it("caps the deep link at four panes and hides Add model at the cap", () => {
    render(
      <PlaygroundChat
        initialModelSlugs={["alpha", "bravo", "charlie", "delta", "echo"]}
        models={MODELS}
        orgId="org-1"
      />
    );
    expect(panes()).toHaveLength(4);
    expect(screen.queryByLabelText("Add model")).toBeNull();
  });

  it("one submit fans out to every model concurrently and streams each pane independently", async () => {
    const bodies: Array<{ model: string }> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      bodies.push(body);
      if (body.model === "bravo") {
        return new Response(JSON.stringify({ error: "no credits" }), { status: 402 });
      }
      return sseResponse(replyEvents(`Hello from ${body.model}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PlaygroundChat initialModelSlugs={["alpha", "bravo"]} models={MODELS} orgId="org-1" />
    );
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Hello from alpha")).toBeTruthy();
    });
    // The failing model reports in its own pane; the healthy pane is untouched.
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("no credits");
    });
    expect(bodies.map((body) => body.model).sort()).toEqual(["alpha", "bravo"]);
    // Both panes carry the shared user turn.
    for (const pane of panes()) {
      expect(within(pane).getByText("hi")).toBeTruthy();
    }
  });

  it("adds a pane through the Add model picker and mirrors ?models= in place", async () => {
    render(
      <PlaygroundChat initialModelSlugs={["alpha", "bravo"]} models={MODELS} orgId="org-1" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.click(await screen.findByRole("option", { name: /Charlie/ }));

    expect(panes()).toHaveLength(3);
    expect(decodeURIComponent(lastMirroredUrl())).toContain("models=alpha,bravo,charlie");
    expect(replace).not.toHaveBeenCalled();
  });

  it("removes a pane and falls back to the historic ?model= shape at one model", () => {
    render(
      <PlaygroundChat initialModelSlugs={["alpha", "bravo"]} models={MODELS} orgId="org-1" />
    );
    fireEvent.click(screen.getByLabelText("Remove Bravo"));

    // A lone model is the classic playground again: no compare pane chrome.
    expect(screen.queryAllByTestId("playground-pane")).toHaveLength(0);
    const url = lastMirroredUrl();
    expect(url).toContain("model=alpha");
    expect(url).not.toContain("models=");
    expect(replace).not.toHaveBeenCalled();
    // Single mode restores the single-model surfaces.
    expect(screen.getByText("Parameters")).toBeTruthy();
  });

  it("keeps the single-model playground unchanged for ?model= links", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      return sseResponse(replyEvents(`Hello from ${body.model}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlaygroundChat initialModelSlugs={["bravo"]} models={MODELS} orgId="org-1" />);
    // No compare chrome, rail present, picker shows the selection.
    expect(screen.queryAllByTestId("playground-pane")).toHaveLength(0);
    expect(screen.getByText("Parameters")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Bravo");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(screen.getByText("Hello from bravo")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a removed pane's stream so it stops spending, leaving siblings running", async () => {
    const signals = new Map<string, AbortSignal>();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (init?.signal) {
        signals.set(body.model, init.signal);
      }
      if (body.model === "bravo") {
        // A stream that never finishes: only an abort can stop this spend.
        const encoder = new TextEncoder();
        const endless = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"delta","text":"…"}\n\n'));
          }
        });
        return new Response(endless, { status: 200 });
      }
      return sseResponse(replyEvents("Hello from alpha"));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PlaygroundChat initialModelSlugs={["alpha", "bravo"]} models={MODELS} orgId="org-1" />
    );
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(signals.size).toBe(2);
    });

    fireEvent.click(screen.getByLabelText("Remove Bravo"));

    await waitFor(() => {
      expect(signals.get("bravo")?.aborted).toBe(true);
    });
    expect(signals.get("alpha")?.aborted).toBe(false);
  });

  it("refuses a duplicate model and respects the four-pane cap when adding", async () => {
    render(
      <PlaygroundChat
        initialModelSlugs={["alpha", "bravo", "charlie"]}
        models={MODELS}
        orgId="org-1"
      />
    );
    // The add picker only offers models not already on screen.
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: /Delta/ }));
    expect(panes()).toHaveLength(4);
    expect(screen.queryByLabelText("Add model")).toBeNull();
  });
});
