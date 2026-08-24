import { describe, expect, it } from "vitest";

import {
  modelFamily,
  modelFamilyKey,
  modelIconKey,
  sameFamily
} from "@/lib/models-catalog/families";
import { rankByFrontier, rankBySimilarity } from "@/lib/models-catalog/ranking";
import { makeEntry } from "./models-catalog-fixtures";

// The blended catalog order: family derivation, frontier-first cold ordering,
// and similarity-to-anchor for the compare picker. Pure functions over the API
// view shapes, so these lock the exact ordering the storefront renders.

describe("model families", () => {
  it("maps brand names to a shared family, however the slug is spelled", () => {
    const opus = makeEntry({ id: "a", slug: "claude-opus-5", display_name: "Claude Opus 5" });
    const haiku = makeEntry({ id: "b", slug: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" });
    const gpt = makeEntry({ id: "c", slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra" });
    expect(modelFamily(opus).label).toBe("Claude");
    expect(modelFamily(opus).key).toBe("anthropic");
    expect(sameFamily(opus, haiku)).toBe(true);
    expect(sameFamily(opus, gpt)).toBe(false);
    expect(modelFamily(gpt).label).toBe("GPT");
  });

  it("prefers the catalog icon column over name derivation", () => {
    // A custom-named model still groups by its explicit icon key.
    const tagged = makeEntry({ id: "t", slug: "acme-1", display_name: "Acme One", icon: "anthropic" });
    expect(modelFamily(tagged).key).toBe("anthropic");
    expect(modelFamily(tagged).label).toBe("Claude");
  });

  it("falls back to the model's name, not its provider route", () => {
    // A family with no brand rule groups by its display name, not its provider.
    const yi = makeEntry(
      { id: "y", slug: "yi-large", display_name: "Yi Large" },
      [{ provider: "openrouter" }]
    );
    expect(modelFamily(yi).label).toBe("Yi");
    expect(modelFamilyKey(yi)).toBe("name:yi");
  });

  // The catalog serves ~40 makers through a handful of lanes; the serving lane
  // must never masquerade as the maker. These pin the real makers the 800+ row
  // production catalog carries — with the Azure Foundry (`azure_openai-…`) and
  // Bedrock (`bedrock-vendor.…`) prefixes that used to hijack every row into the
  // OpenAI family.
  it.each([
    ["Cohere Command A (Azure Foundry)", "azure_openai-cohere-command-a", "cohere", "Cohere"],
    ["Ai21 Jamba 1.5 Large (Azure Foundry)", "azure_openai-ai21-jamba-1.5-large", "ai21", "AI21"],
    ["Jais 30b Chat (Azure Foundry)", "azure_openai-jais-30b-chat", "jais", "Jais"],
    ["Grok 4 (Azure Foundry)", "azure_openai-grok-4", "xai", "Grok"],
    ["Phi 3 Mini 128k Instruct", "fireworks-models-phi-3-mini-128k-instruct", "microsoft", "Microsoft"],
    ["Mai Ds R1 (Azure Foundry)", "azure_openai-mai-ds-r1", "microsoft", "Microsoft"],
    ["Stable Image Ultra 1.0 (Bedrock)", "bedrock-stability.stable-image-ultra-v1-1", "stability", "Stability"],
    ["Nova Pro (Bedrock)", "bedrock-amazon.nova-pro-v1-0-24k", "amazon", "Amazon"],
    ["Titan Text Embeddings v2 (Bedrock)", "bedrock-amazon.titan-embed-g1-text-02", "amazon", "Amazon"],
    ["NVIDIA Nemotron Nano 9B v2 (Bedrock)", "bedrock-nvidia.nemotron-nano-9b-v2", "nvidia", "NVIDIA"],
    ["MiniMax M2.1 (Bedrock)", "bedrock-minimax.minimax-m2.1", "minimax", "MiniMax"],
    ["Ernie 4p5 21b A3b Pt (Fireworks)", "fireworks-models-ernie-4p5-21b-a3b-pt", "baidu", "Baidu"],
    ["Seed Oss 36b Instruct (Fireworks)", "fireworks-models-seed-oss-36b-instruct", "bytedance", "ByteDance"],
    ["Ministral 3 8b Instruct 2512 (Fireworks)", "fireworks-models-ministral-3-8b-instruct-2512", "mistral", "Mistral"],
    ["Nous Hermes Llama2 13b (Fireworks)", "fireworks-models-nous-hermes-llama2-13b", "nous", "Nous"],
    ["Flux 1 Schnell (Fireworks)", "fireworks-models-flux-1-schnell", "blackforest", "FLUX"],
    ["Voyage 4 Large (Fireworks)", "fireworks-models-voyage-4-large", "voyage", "Voyage"],
    ["Inkling Small (Fireworks)", "fireworks-models-inkling-small", "thinkingmachines", "Thinking Machines"],
    ["Gpt Oss 120b (Azure Foundry)", "azure_openai-fw-gpt-oss-120b", "openai", "GPT"],
    ["Text Embedding 3 Large (Azure Foundry)", "azure_openai-text-embedding-3-large", "openai", "GPT"]
  ])("classifies %s as its maker, not its serving lane", (display_name, slug, key, label) => {
    const entry = makeEntry({ id: slug, slug, display_name });
    expect(modelFamily(entry).key).toBe(key);
    expect(modelFamily(entry).label).toBe(label);
    expect(modelIconKey(entry.model)).toBe(key);
  });

  it("gives an unmapped community model a null-ish name key with no maker mark", () => {
    const zephyr = makeEntry({ id: "z", slug: "fireworks-models-zephyr-7b-beta", display_name: "Zephyr 7b Beta" });
    expect(modelIconKey(zephyr.model)).toBe("name:zephyr");
  });

  it("still honors an explicit icon column over the serving lane", () => {
    const tagged = makeEntry({ id: "t", slug: "acme-1", display_name: "Acme One", icon: "cohere" });
    expect(modelIconKey(tagged.model)).toBe("cohere");
  });
});

describe("frontier ordering (cold catalog)", () => {
  it("puts preferred models first, then the newest / most capable blend", () => {
    const preferred = makeEntry(
      { id: "pref", slug: "pref", display_name: "Pref", preferred_rank: 1, release_date: "2025-01-01" },
      [{ input_micro_usd_per_million: 100_000 }]
    );
    const frontier = makeEntry(
      { id: "new", slug: "new", display_name: "New", release_date: "2026-08-01", context_window: 1_000_000 },
      [{ input_micro_usd_per_million: 5_000_000 }]
    );
    const old = makeEntry(
      { id: "old", slug: "old", display_name: "Old", release_date: "2024-01-01", context_window: 8_000 },
      [{ input_micro_usd_per_million: 200_000 }]
    );
    const order = rankByFrontier([old, frontier, preferred]).map((entry) => entry.model.id);
    expect(order[0]).toBe("pref");
    expect(order.indexOf("new")).toBeLessThan(order.indexOf("old"));
  });

  it("pins a rank-0 featured model above the rest of the recommended band", () => {
    // ox-alpha is seeded at preferred_rank 0 to sit one step above the band's
    // rank 1, so it must lead the whole catalog — ahead of the top recommended
    // model and every organic frontier entry.
    const featured = makeEntry(
      { id: "ox-alpha", slug: "ox-alpha", display_name: "Ox Alpha", preferred_rank: 0, context_window: 1_048_576 },
      [{ input_micro_usd_per_million: 0 }]
    );
    const topBand = makeEntry(
      {
        id: "fable",
        slug: "claude-fable-5",
        display_name: "Claude Fable 5",
        preferred_rank: 1,
        release_date: "2026-06-09",
        context_window: 1_000_000
      },
      [{ input_micro_usd_per_million: 10_000_000 }]
    );
    const organic = makeEntry(
      { id: "new", slug: "new", display_name: "New", release_date: "2026-08-01", context_window: 1_000_000 },
      [{ input_micro_usd_per_million: 5_000_000 }]
    );
    const order = rankByFrontier([organic, topBand, featured]).map((entry) => entry.model.id);
    expect(order[0]).toBe("ox-alpha");
    expect(order.indexOf("fable")).toBeLessThan(order.indexOf("new"));
  });
});

describe("similarity ordering (compare picker)", () => {
  it("ranks the closest model first and pulls same-family siblings closer", () => {
    const anchor = makeEntry(
      { id: "anchor", slug: "claude-opus-5", display_name: "Claude Opus 5", release_date: "2026-06-01", context_window: 200_000 },
      [{ input_micro_usd_per_million: 5_000_000 }]
    );
    // A same-family sibling and a different-family model at the SAME raw
    // distance from the anchor (identical specs) — the family boost is the only
    // thing that separates them, so the sibling must come first.
    const sibling = makeEntry(
      { id: "sib", slug: "claude-sonnet-5", display_name: "Claude Sonnet 5", release_date: "2026-06-01", context_window: 200_000 },
      [{ input_micro_usd_per_million: 1_000_000 }]
    );
    const other = makeEntry(
      { id: "other", slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", release_date: "2026-06-01", context_window: 200_000 },
      [{ input_micro_usd_per_million: 1_000_000 }]
    );
    const ranked = rankBySimilarity([other, sibling, anchor], anchor).map((entry) => entry.model.id);
    // The anchor is never in its own ranked list.
    expect(ranked).not.toContain("anchor");
    // The same-family sibling is boosted ahead of the unrelated model.
    expect(ranked[0]).toBe("sib");
  });

  it("falls back to frontier order when the anchor is null", () => {
    const a = makeEntry({ id: "a", slug: "a", display_name: "A", preferred_rank: 1 });
    const b = makeEntry({ id: "b", slug: "b", display_name: "B" });
    expect(rankBySimilarity([b, a], null).map((entry) => entry.model.id)[0]).toBe("a");
  });
});
