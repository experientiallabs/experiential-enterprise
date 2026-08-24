import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TrainingCapCard } from "@/components/settings/TrainingCapCard";

// The automatic-training spend ceiling (the product owner, 2026-07-31: a setting, not a
// constant). These pin the three states a member can see: the platform
// default, an org override, and the admin write path with its reset.

function mockBudget(options: { cap: number | null; puts: Array<Record<string, unknown>> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/training-cap")) {
        options.puts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return { ok: true, json: async () => ({ training_cap_usd: null }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          training_cap_usd: options.cap,
          training_cap_default_usd: 100
        })
      } as Response;
    })
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TrainingCapCard", () => {
  it("shows the platform default, named as the default", async () => {
    mockBudget({ cap: null, puts: [] });
    render(<TrainingCapCard canManage={false} orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("training-cap-value")).toHaveTextContent("$100");
    });
    expect(screen.getByTestId("training-cap-value")).toHaveTextContent("platform default");
    // A plain member reads the ceiling but gets no editor.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("shows an org override without the default label", async () => {
    mockBudget({ cap: 42.5, puts: [] });
    render(<TrainingCapCard canManage orgId="org-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("training-cap-value")).toHaveTextContent("$42.5");
    });
    expect(screen.getByTestId("training-cap-value")).not.toHaveTextContent("platform default");
  });

  it("saves an admin's new ceiling and can reset to the default", async () => {
    const puts: Array<Record<string, unknown>> = [];
    mockBudget({ cap: 42.5, puts });
    render(<TrainingCapCard canManage orgId="org-1" />);

    const input = await screen.findByLabelText("Training run ceiling in dollars");
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(puts).toContainEqual({ training_cap_usd: 60 });
    });

    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    await waitFor(() => {
      expect(puts).toContainEqual({ training_cap_usd: null });
    });
  });
});
