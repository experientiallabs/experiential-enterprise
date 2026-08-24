import { describe, expect, it } from "vitest";

import {
  isHostServed,
  pinExperientialCloudFirst,
  requiresOwnKey,
  servedThroughExperiential,
  servingLane
} from "@/lib/models-catalog/serving";
import { makeDeployment, makeEntry } from "./models-catalog-fixtures";

describe("serving truth", () => {
  it("treats an active public host-managed route as served through Experiential", () => {
    const deployment = makeDeployment({
      billing_source: "host_managed",
      status: "active",
      owning_org_id: null
    });
    expect(isHostServed(deployment)).toBe(true);
    expect(servingLane(deployment)).toBe("experiential");
  });

  it("does NOT treat a public customer_managed route as host-served", () => {
    // The bug this fixes: a public BYOK route (owning_org_id null) used to read
    // as "Through Experiential — uses credits". It is not funded by the platform.
    const deployment = makeDeployment({
      billing_source: "customer_managed",
      status: "active",
      owning_org_id: null
    });
    expect(isHostServed(deployment)).toBe(false);
    expect(servingLane(deployment)).toBe("byok");
  });

  it("does NOT host-serve a disabled host-managed route", () => {
    const deployment = makeDeployment({
      billing_source: "host_managed",
      status: "disabled",
      owning_org_id: null
    });
    expect(isHostServed(deployment)).toBe(false);
    expect(servingLane(deployment)).toBe("byok");
  });

  it("classifies a local route as self-hosted, never Experiential", () => {
    const deployment = makeDeployment({
      provider: "local",
      billing_source: "customer_managed",
      owning_org_id: "org-1",
      base_url: "http://localhost:8000"
    });
    expect(servingLane(deployment)).toBe("local");
  });

  it("marks a model served when any route is host-served", () => {
    const providers = [
      makeDeployment({ billing_source: "customer_managed", owning_org_id: null }),
      makeDeployment({ billing_source: "host_managed", status: "active", owning_org_id: null })
    ];
    expect(servedThroughExperiential(providers)).toBe(true);
  });

  it("marks a BYOK-only model as requiring the user's own key", () => {
    const entry = makeEntry({}, [
      { billing_source: "customer_managed", status: "active", owning_org_id: null }
    ]);
    expect(servedThroughExperiential(entry.providers)).toBe(false);
    expect(requiresOwnKey(entry)).toBe(true);
  });

  it("does not report requiresOwnKey for a model with no routes at all", () => {
    const entry = makeEntry({}, []);
    expect(requiresOwnKey(entry)).toBe(false);
  });

  it("pins experiential_cloud first and keeps the rest in incoming order", () => {
    const openrouter = makeDeployment({ id: "or", provider: "openrouter", throughput_tps: 200 });
    const azure = makeDeployment({ id: "az", provider: "azure_openai", throughput_tps: 150 });
    const cloud = makeDeployment({ id: "ec", provider: "experiential_cloud", throughput_tps: 40 });
    expect(pinExperientialCloudFirst([openrouter, azure, cloud]).map((row) => row.id)).toEqual([
      "ec",
      "or",
      "az"
    ]);
  });
});
