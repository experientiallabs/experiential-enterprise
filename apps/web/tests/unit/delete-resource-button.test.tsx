import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh })
}));

import { DeleteResourceButton } from "@/components/ui/DeleteResourceButton";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resource deletion warnings", () => {
  it("warns before deleting a world model and Cancel preserves it", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DeleteResourceButton
        deletePath="/api/world-models/wm1"
        errorFallback="Unable to delete the simulation."
        redirectPath="/simulations"
        resourceLabel="simulation"
        resourceName="tau-bench"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Are you sure you want to delete this?" })
    ).toBeInTheDocument();
    expect(screen.getByText(/tau-bench/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dismisses the warning with Escape without deleting", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DeleteResourceButton
        deletePath="/api/world-models/wm1"
        errorFallback="Unable to delete the simulation."
        redirectPath="/simulations"
        resourceLabel="simulation"
        resourceName="tau-bench"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes a world model only after confirmation and returns to the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DeleteResourceButton
        deletePath="/api/world-models/wm1"
        errorFallback="Unable to delete the simulation."
        redirectPath="/simulations"
        resourceLabel="simulation"
        resourceName="tau-bench"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete simulation" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/simulations"));
    expect(fetchMock).toHaveBeenCalledWith("/api/world-models/wm1", { method: "DELETE" });
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps the warning open and shows backend errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Only an organization admin can delete this." }), {
          status: 403
        })
      )
    );
    render(
      <DeleteResourceButton
        deletePath="/api/world-models/wm1"
        errorFallback="Unable to delete the simulation."
        redirectPath="/simulations"
        resourceLabel="simulation"
        resourceName="tau-bench"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete simulation" }));

    expect(await screen.findByText(/only an organization admin/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
