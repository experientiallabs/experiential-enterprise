import { describe, expect, it } from "vitest";

import { isSelfHostable, modelFamily } from "@/lib/models-catalog/families";
import { makeEntry, makeModel } from "./models-catalog-fixtures";

describe("modelFamily", () => {
  it("reads the icon column as the family key", () => {
    expect(modelFamily(makeEntry({ icon: "qwen" })).label).toBe("Qwen");
  });

  it("falls back to name rules when the icon is null", () => {
    expect(modelFamily(makeEntry({ icon: null, display_name: "Claude Sonnet 5" })).key).toBe(
      "anthropic"
    );
  });
});

describe("isSelfHostable", () => {
  it("is false for proprietary, API-only families", () => {
    for (const icon of ["anthropic", "openai", "google", "xai", "amazon", "perplexity"]) {
      expect(isSelfHostable(makeModel({ icon }))).toBe(false);
    }
  });

  it("is true for open-weights families", () => {
    for (const icon of ["qwen", "deepseek", "meta", "mistral", "moonshot", "zai", "nvidia"]) {
      expect(isSelfHostable(makeModel({ icon }))).toBe(true);
    }
  });

  it("treats Gemma as self-hostable despite sharing Google's family key", () => {
    expect(isSelfHostable(makeModel({ icon: "google", display_name: "Gemma 3 27B" }))).toBe(true);
    // Gemini, the proprietary sibling under the same key, stays API-only.
    expect(isSelfHostable(makeModel({ icon: "google", display_name: "Gemini 3 Pro" }))).toBe(false);
  });

  it("treats the generic bucket and an org's own custom model as self-hostable", () => {
    expect(isSelfHostable(makeModel({ icon: "openrouter", display_name: "Solar Pro 4" }))).toBe(
      true
    );
    expect(
      isSelfHostable(makeModel({ icon: null, display_name: "Acme Internal 7B", owning_org_id: "org-1" }))
    ).toBe(true);
  });
});
