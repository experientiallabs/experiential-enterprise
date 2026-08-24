import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptCaptureCard } from "@/components/settings/PromptCaptureCard";

// The org opt-in to capture request/response content (default OFF). These pin
// the read state, the admin write path, and the non-admin read-only state.

function mockSettings(options: {
  captureOn: boolean;
  puts: Array<Record<string, unknown>>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        options.puts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return { ok: true, json: async () => JSON.parse(String(init?.body ?? "{}")) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ capture_prompt_content: options.captureOn })
      } as Response;
    })
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PromptCaptureCard", () => {
  it("shows content capture off by default and lets an admin turn it on", async () => {
    const puts: Array<Record<string, unknown>> = [];
    mockSettings({ captureOn: false, puts });
    render(<PromptCaptureCard canManage orgId="org-1" />);

    const toggle = await screen.findByLabelText("Capture prompt and response content");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Content capture off/)).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(puts).toEqual([{ capture_prompt_content: true }]));
    expect(await screen.findByText(/Capturing prompt content/)).toBeInTheDocument();
  });

  it("reflects the enabled state and denies a non-admin the toggle", async () => {
    mockSettings({ captureOn: true, puts: [] });
    render(<PromptCaptureCard canManage={false} orgId="org-1" />);

    const toggle = await screen.findByLabelText("Capture prompt and response content");
    await waitFor(() => expect(toggle).toBeChecked());
    // A non-admin sees the state but cannot change it.
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/Only an organization admin can change this/)).toBeInTheDocument();
  });
});
