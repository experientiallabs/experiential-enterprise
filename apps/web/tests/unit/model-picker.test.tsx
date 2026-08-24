import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelPicker } from "@/components/playground/ModelPicker";
import { makeEntry } from "./models-catalog-fixtures";

const ENTRIES = [
  makeEntry({ id: "m-a", slug: "alpha", display_name: "Alpha" }),
  makeEntry({ id: "m-b", slug: "bravo", display_name: "Bravo" }),
  makeEntry({ id: "m-c", slug: "charlie", display_name: "Charlie" })
];

// Recommended (preferred_rank) + plain models across two providers, to exercise
// the Recommended-first grouping and the collapsible provider sections.
const GROUPED = [
  makeEntry({ id: "r1", slug: "rec-one", display_name: "Rec One", preferred_rank: 1 }, [
    { provider: "openai" }
  ]),
  makeEntry({ id: "r2", slug: "rec-two", display_name: "Rec Two", preferred_rank: 2 }, [
    { provider: "anthropic" }
  ]),
  makeEntry({ id: "p1", slug: "plain-oai", display_name: "Plain OpenAI" }, [{ provider: "openai" }]),
  makeEntry({ id: "p2", slug: "plain-ant", display_name: "Plain Anthropic" }, [
    { provider: "anthropic" }
  ])
];

function open(models = ENTRIES, selectedSlug: string | null = "alpha") {
  const onSelect = vi.fn();
  render(<ModelPicker models={models} onSelect={onSelect} selectedSlug={selectedSlug} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  // Menu is portaled to document.body; the listbox proves it opened.
  expect(screen.getByRole("listbox")).toBeTruthy();
  return { onSelect };
}

describe("ModelPicker dropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays open while scrolling its own list", () => {
    open();
    const menu = screen.getByRole("listbox");
    // A scroll originating inside the menu must not dismiss it.
    fireEvent.scroll(menu);
    expect(screen.queryByRole("listbox")).toBeTruthy();
  });

  it("stays open while the page scrolls (menu repositions, not closes)", () => {
    open();
    fireEvent.scroll(window);
    expect(screen.queryByRole("listbox")).toBeTruthy();
  });

  it("closes and reports the choice on select", () => {
    // ENTRIES are un-pinned openai models, so they live in the collapsed
    // "OpenAI" section — expand it, then pick a row.
    const { onSelect } = open();
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    fireEvent.click(screen.getByRole("option", { name: /Bravo/ }));
    expect(onSelect).toHaveBeenCalledWith("bravo");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape", () => {
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on outside pointerdown", () => {
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("ModelPicker grouping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pins recommended models first and shows them without expanding", () => {
    open(GROUPED, "rec-one");
    const recommended = screen.getByRole("group", { name: "Recommended" });
    expect(recommended).toBeTruthy();
    // Recommended rows are visible immediately (the group is always open).
    expect(screen.getByRole("option", { name: /Rec One/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Rec Two/ })).toBeTruthy();
  });

  it("collapses provider sections by default and expands on header click", () => {
    open(GROUPED, "rec-one");
    // A non-recommended model sits in a collapsed provider section: hidden until
    // its header is clicked.
    expect(screen.queryByRole("option", { name: /Plain Anthropic/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Anthropic/ }));
    expect(screen.getByRole("option", { name: /Plain Anthropic/ })).toBeTruthy();
  });

  it("does not duplicate a recommended model into its provider section", () => {
    open(GROUPED, "rec-one");
    // Rec Two is anthropic + recommended; expanding Anthropic must not list it
    // again (it stays only in Recommended).
    fireEvent.click(screen.getByRole("button", { name: /Anthropic/ }));
    expect(screen.getAllByRole("option", { name: /Rec Two/ })).toHaveLength(1);
  });

  it("flattens to filtered results (no groups) while searching", () => {
    open(GROUPED, "rec-one");
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "plain" } });
    // Both plain models are visible flat, with no group scaffolding.
    expect(screen.getByRole("option", { name: /Plain OpenAI/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Plain Anthropic/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Recommended" })).toBeNull();
  });

  it("selects a model from an expanded provider section", () => {
    const { onSelect } = open(GROUPED, "rec-one");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    fireEvent.click(screen.getByRole("option", { name: /Plain OpenAI/ }));
    expect(onSelect).toHaveBeenCalledWith("plain-oai");
  });
});
