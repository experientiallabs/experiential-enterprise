import { describe, expect, it } from "vitest";

import { connectableProvidersForModel, MODEL_PROVIDERS } from "@/lib/model-providers";

describe("connectableProvidersForModel", () => {
  it("returns the model-scoped BYOK providers in catalog order, deduped", () => {
    expect(
      connectableProvidersForModel([
        { provider: "openai" },
        { provider: "azure_openai" },
        { provider: "openai" }
      ])
    ).toEqual(["openai", "azure_openai"]);
  });

  it("drops non-BYOK deployments (a local endpoint is not a key)", () => {
    expect(
      connectableProvidersForModel([{ provider: "local" }, { provider: "anthropic" }])
    ).toEqual(["anthropic"]);
  });

  it("falls back to the full provider list when the catalog names none we can key", () => {
    // Only a self-hosted route: without the fallback the add-key flow would show
    // nothing, which is exactly the bug — a user must always get a platform choice.
    expect(connectableProvidersForModel([{ provider: "local" }])).toEqual([...MODEL_PROVIDERS]);
  });

  it("falls back to the full provider list for a model with no deployments at all", () => {
    expect(connectableProvidersForModel([])).toEqual([...MODEL_PROVIDERS]);
  });
});
