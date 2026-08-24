import { describe, expect, it } from "vitest";

import { promoChipsBySlug, rankPromosForSlug } from "@/lib/models-catalog/promotions";
import type { ModelPromotion } from "@/lib/models-catalog/types";

function makePromo(overrides: Partial<ModelPromotion> = {}): ModelPromotion {
  return {
    label: "Promo",
    slugs: ["model-a"],
    display_order: 0,
    free: false,
    percent_off: 0,
    providers: [],
    family_keys: [],
    ...overrides
  };
}

describe("rankPromosForSlug", () => {
  it("ranks a free promo above any percent promo", () => {
    const chip = rankPromosForSlug([
      makePromo({ percent_off: 90, display_order: 0 }),
      makePromo({ free: true, providers: ["experiential_cloud"], display_order: 9 })
    ]);
    expect(chip).toEqual({ kind: "free", providers: ["experiential_cloud"] });
  });

  it("breaks free-vs-free ties on the lowest display_order", () => {
    const chip = rankPromosForSlug([
      makePromo({ free: true, providers: ["bedrock"], display_order: 4 }),
      makePromo({ free: true, providers: [], display_order: 1 })
    ]);
    expect(chip).toEqual({ kind: "free", providers: [] });
  });

  it("picks the highest percent_off among percent promos", () => {
    const chip = rankPromosForSlug([
      makePromo({ percent_off: 20, display_order: 0 }),
      makePromo({ percent_off: 50, providers: ["experiential_cloud"], display_order: 7 })
    ]);
    expect(chip).toEqual({
      kind: "percent",
      percent_off: 50,
      providers: ["experiential_cloud"]
    });
  });

  it("breaks equal percents on the lowest display_order", () => {
    const chip = rankPromosForSlug([
      makePromo({ percent_off: 50, providers: ["fireworks"], display_order: 3 }),
      makePromo({ percent_off: 50, providers: [], display_order: 1 })
    ]);
    expect(chip).toEqual({ kind: "percent", percent_off: 50, providers: [] });
  });

  it("returns null when nothing chip-worthy covers the slug", () => {
    expect(rankPromosForSlug([])).toBeNull();
    // A promo with neither a free tier nor a discount earns no chip.
    expect(rankPromosForSlug([makePromo()])).toBeNull();
  });
});

describe("promoChipsBySlug", () => {
  it("ranks per slug across the whole promotion set", () => {
    const chips = promoChipsBySlug([
      makePromo({ slugs: ["model-a", "model-b"], free: true, display_order: 0 }),
      makePromo({
        slugs: ["model-b", "model-c"],
        percent_off: 50,
        providers: ["experiential_cloud"],
        display_order: 1
      })
    ]);
    // model-a: free only; model-b: overlap resolves to free; model-c: percent.
    expect(chips.get("model-a")).toEqual({ kind: "free", providers: [] });
    expect(chips.get("model-b")).toEqual({ kind: "free", providers: [] });
    expect(chips.get("model-c")).toEqual({
      kind: "percent",
      percent_off: 50,
      providers: ["experiential_cloud"]
    });
    expect(chips.has("model-d")).toBe(false);
  });
});
