import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() })
}));

import {
  RecommendedModelsCard,
  type RecommendedModelOption
} from "@/components/admin/RecommendedModelsCard";
import type { RecommendedModel } from "@/lib/recommended-models/types";

const RECOMMENDED: RecommendedModel[] = [
  { slug: "ox-alpha", display_name: "Ox Alpha", preferred_rank: 0 },
  { slug: "claude-fable-5", display_name: "Claude Fable 5", preferred_rank: 1 },
  { slug: "qwen3.8-27b", display_name: "Qwen3.8 27B", preferred_rank: 2 }
];

const MODELS: RecommendedModelOption[] = [
  { slug: "ox-alpha", display_name: "Ox Alpha" },
  { slug: "claude-fable-5", display_name: "Claude Fable 5" },
  { slug: "qwen3.8-27b", display_name: "Qwen3.8 27B" },
  { slug: "glm-5.3", display_name: "GLM 5.3" }
];

function renderCard(recommended: RecommendedModel[] = RECOMMENDED) {
  return render(<RecommendedModelsCard models={MODELS} recommended={recommended} />);
}

// Row order read through the remove buttons' accessible names, which carry
// the slug and exist once per row.
function listedSlugs(): string[] {
  return screen
    .getAllByLabelText(/^Remove /)
    .map((button) => (button.getAttribute("aria-label") ?? "").replace("Remove ", ""));
}

// The row is the draggable element; the grip handle inside it carries the
// accessible name.
function rowOf(slug: string): HTMLElement {
  const row = screen.getByLabelText(`Reorder ${slug}`).closest("li");
  if (row === null) {
    throw new Error(`no draggable row for ${slug}`);
  }
  return row;
}

function dragRow(fromSlug: string, toSlug: string) {
  fireEvent.dragStart(rowOf(fromSlug));
  fireEvent.dragOver(rowOf(toSlug));
  fireEvent.drop(rowOf(toSlug));
}

function lastFetchBody(): { slugs: string[] } {
  const calls = vi.mocked(fetch).mock.calls;
  const [, init] = calls[calls.length - 1] as [string, { body?: string }];
  return JSON.parse(init.body ?? "{}") as { slugs: string[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RecommendedModelsCard", () => {
  it("renders the current set in rank order with save disabled until edited", () => {
    renderCard();
    expect(listedSlugs()).toEqual(["ox-alpha", "claude-fable-5", "qwen3.8-27b"]);
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
  });

  it("drag-reorders a model and saves the full list in one PUT", async () => {
    renderCard();
    dragRow("claude-fable-5", "ox-alpha");
    expect(listedSlugs()).toEqual(["claude-fable-5", "ox-alpha", "qwen3.8-27b"]);
    const save = screen.getByRole("button", { name: "Save order" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await screen.findByText("Recommended set saved.");
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/recommended-models",
      expect.objectContaining({ method: "PUT" })
    );
    expect(lastFetchBody()).toEqual({
      slugs: ["claude-fable-5", "ox-alpha", "qwen3.8-27b"]
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("moves a row with the arrow keys on the focused grip", () => {
    renderCard();
    fireEvent.keyDown(screen.getByLabelText("Reorder claude-fable-5"), { key: "ArrowUp" });
    expect(listedSlugs()).toEqual(["claude-fable-5", "ox-alpha", "qwen3.8-27b"]);
    fireEvent.keyDown(screen.getByLabelText("Reorder claude-fable-5"), { key: "ArrowDown" });
    expect(listedSlugs()).toEqual(["ox-alpha", "claude-fable-5", "qwen3.8-27b"]);
  });

  it("dropping a row on itself changes nothing and save stays disabled", () => {
    renderCard();
    dragRow("ox-alpha", "ox-alpha");
    expect(listedSlugs()).toEqual(["ox-alpha", "claude-fable-5", "qwen3.8-27b"]);
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
  });

  it("adds a catalog model by slug at the end of the list", () => {
    renderCard();
    fireEvent.change(screen.getByLabelText("Add a model by slug"), {
      target: { value: "glm-5.3" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(listedSlugs()).toEqual(["ox-alpha", "claude-fable-5", "qwen3.8-27b", "glm-5.3"]);
  });

  it("refuses an unknown slug and a slug already in the set", () => {
    renderCard();
    const input = screen.getByLabelText("Add a model by slug");
    fireEvent.change(input, { target: { value: "no-such-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText('"no-such-model" is not a catalog model slug.')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "ox-alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(
      screen.getByText('"ox-alpha" is already in the recommended set.')
    ).toBeInTheDocument();
    expect(listedSlugs()).toEqual(["ox-alpha", "claude-fable-5", "qwen3.8-27b"]);
  });

  it("removes a model, and an emptied set cannot be saved", () => {
    renderCard([RECOMMENDED[0]]);
    fireEvent.click(screen.getByRole("button", { name: "Remove ox-alpha" }));
    expect(
      screen.getByText("No recommended models. Add at least one: an empty set cannot be saved.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces the backend error when the save is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "unknown public model slugs: glm-5.3" }), {
            status: 400
          })
      )
    );
    renderCard();
    dragRow("claude-fable-5", "ox-alpha");
    fireEvent.click(screen.getByRole("button", { name: "Save order" }));
    expect(await screen.findByText("unknown public model slugs: glm-5.3")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
