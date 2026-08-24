import { describe, expect, it } from "vitest";

import { MODEL_PROVIDERS } from "@/lib/model-providers";
import { DEAL_CATALOG, dealsForProvider, matchDeals } from "@/lib/deals-catalog";

describe("deals-catalog", () => {
  it("pins the FINAL Bookface mapping the product owner verified (2026-08-22)", () => {
    expect(DEAL_CATALOG.map((deal) => [deal.provider, deal.url])).toEqual([
      ["openai", "https://bookface.ycombinator.com/deals/1597"],
      ["anthropic", "https://bookface.ycombinator.com/deals/2153"],
      ["openrouter", "https://bookface.ycombinator.com/deals/3222"],
      ["gemini", "https://bookface.ycombinator.com/deals/4"],
      ["bedrock", "https://bookface.ycombinator.com/deals/3"],
      ["azure_openai", "https://bookface.ycombinator.com/deals/2155"],
      ["fireworks", "https://bookface.ycombinator.com/deals/2926"],
      ["modal", "https://bookface.ycombinator.com/deals/1682"]
    ]);
  });

  it("carries exactly one deal per connectable inference provider", () => {
    expect(DEAL_CATALOG).toHaveLength(MODEL_PROVIDERS.length);
    for (const provider of MODEL_PROVIDERS) {
      expect(dealsForProvider(provider)).toHaveLength(1);
    }
  });

  it("carries no unverified dollar figures in headlines", () => {
    for (const deal of DEAL_CATALOG) {
      expect(deal.headline).not.toMatch(/\$|\d/);
    }
  });

  it("moves deals for connected providers into the claim group", () => {
    const { claim, available } = matchDeals(["openai", "bedrock"]);
    const claimIds = claim.map((deal) => deal.id);
    expect(claimIds).toContain("openai");
    expect(claimIds).toContain("aws");
    // A claimed deal is never also offered as available.
    expect(available.map((deal) => deal.id)).not.toContain("openai");
    // Nothing is dropped: claim + available cover the whole catalog.
    expect(claim.length + available.length).toBe(DEAL_CATALOG.length);
  });

  it("offers the whole catalog when nothing is connected", () => {
    const { claim, available } = matchDeals([]);
    expect(claim).toHaveLength(0);
    expect(available).toHaveLength(DEAL_CATALOG.length);
  });
});
