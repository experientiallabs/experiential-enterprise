import { describe, expect, it } from "vitest";

import {
  promoChipsBySlug,
  promoEffectiveMicro,
  promoEffectivePrice,
  rankPromosForSlug
} from "@/lib/models-catalog/promotions";
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

describe("promoEffectiveMicro", () => {
  it("prices a free promo at zero and discounts a percent promo, rounded", () => {
    expect(promoEffectiveMicro({ kind: "free", providers: [] }, 5_000_000)).toBe(0);
    expect(
      promoEffectiveMicro({ kind: "percent", percent_off: 50, providers: [] }, 5_000_000)
    ).toBe(2_500_000);
    expect(
      promoEffectiveMicro({ kind: "percent", percent_off: 33, providers: [] }, 1_000_001)
    ).toBe(670_001);
  });

  it("reprices lane-aware: covered lanes discount, uncovered lanes never do, and the floor is the cheaper", () => {
    const lanes = [
      { provider: "openrouter", micro: 4_000_000 },
      { provider: "experiential_cloud", micro: 5_000_000 }
    ];
    const scoped50 = { kind: "percent" as const, percent_off: 50, providers: ["experiential_cloud"] };
    // Covered EC lane at $5 discounts to $2.50, beating the $4 uncovered list.
    expect(promoEffectivePrice(scoped50, lanes)).toEqual({ list: 4_000_000, effective: 2_500_000 });
    // A 10% covered discount ($4.50) does NOT beat the $4 uncovered route: no repricing.
    expect(
      promoEffectivePrice({ kind: "percent", percent_off: 10, providers: ["experiential_cloud"] }, lanes)
    ).toEqual({ list: 4_000_000, effective: 4_000_000 });
    // A scoped promo with no covered priced lane is a passthrough.
    expect(
      promoEffectivePrice({ kind: "free", providers: ["gemini"] }, lanes)
    ).toEqual({ list: 4_000_000, effective: 4_000_000 });
    // Unscoped promos reprice the list price; unknown prices stay unknown.
    expect(promoEffectivePrice({ kind: "free", providers: [] }, lanes)).toEqual({
      list: 4_000_000,
      effective: 0
    });
    expect(promoEffectivePrice({ kind: "free", providers: [] }, [])).toEqual({
      list: null,
      effective: null
    });
  });

  it("leaves an unpromoted or unpriced model untouched: no chip is a passthrough and unknown never becomes free", () => {
    expect(promoEffectiveMicro(null, 5_000_000)).toBe(5_000_000);
    expect(promoEffectiveMicro(undefined, 5_000_000)).toBe(5_000_000);
    expect(promoEffectiveMicro({ kind: "free", providers: [] }, null)).toBeNull();
    expect(
      promoEffectiveMicro({ kind: "percent", percent_off: 50, providers: [] }, null)
    ).toBeNull();
  });
});
