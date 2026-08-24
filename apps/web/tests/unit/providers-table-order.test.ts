import { describe, expect, it } from "vitest";

import {
  defaultProviderOrder,
  providerColumnSortKey,
  quantizationOf
} from "@/components/models-catalog/detail/providers-table";
import { makeDeployment } from "./models-catalog-fixtures";

describe("providers table default order", () => {
  it("pins Experiential-hosted lanes first, then highest throughput", () => {
    const byokFast = makeDeployment({
      id: "byok-fast",
      provider: "fireworks",
      billing_source: "customer_managed",
      throughput_tps: 200
    });
    const cloudSlow = makeDeployment({
      id: "cloud-slow",
      provider: "openrouter",
      billing_source: "host_managed",
      status: "active",
      throughput_tps: 40
    });
    const byokNoStats = makeDeployment({
      id: "byok-none",
      provider: "bedrock",
      billing_source: "customer_managed",
      throughput_tps: null
    });
    const order = defaultProviderOrder([byokFast, byokNoStats, cloudSlow]).map((d) => d.id);
    // Cloud-first beats raw throughput in the DEFAULT view; BYOK sorts by tok/s.
    expect(order).toEqual(["cloud-slow", "byok-fast", "byok-none"]);
  });

  it("pins experiential_cloud first even when another host-served lane is faster", () => {
    const openrouterFast = makeDeployment({
      id: "or-fast",
      provider: "openrouter",
      billing_source: "host_managed",
      status: "active",
      throughput_tps: 200
    });
    const cloudSlow = makeDeployment({
      id: "ec-slow",
      provider: "experiential_cloud",
      billing_source: "host_managed",
      status: "active",
      throughput_tps: 40
    });
    const azureMid = makeDeployment({
      id: "az-mid",
      provider: "azure_openai",
      billing_source: "host_managed",
      status: "active",
      throughput_tps: 150
    });
    expect(
      defaultProviderOrder([openrouterFast, azureMid, cloudSlow]).map((row) => row.id)
    ).toEqual(["ec-slow", "or-fast", "az-mid"]);
    expect(providerColumnSortKey(cloudSlow) < providerColumnSortKey(openrouterFast)).toBe(true);
    expect(providerColumnSortKey(cloudSlow) < providerColumnSortKey(azureMid)).toBe(true);
  });
});

describe("quantization parsing", () => {
  it("reads the quant tag from the wire id, null when unpublished", () => {
    expect(
      quantizationOf(
        makeDeployment({ provider_model_id: "accounts/fireworks/models/glm-5p2-fp8" })
      )
    ).toBe("fp8");
    expect(
      quantizationOf(makeDeployment({ provider_model_id: "FW-Nemotron-3-Ultra-NVFP4" }))
    ).toBe("nvfp4");
    expect(quantizationOf(makeDeployment({ provider_model_id: "z-ai/glm-5.3" }))).toBeNull();
  });
});
