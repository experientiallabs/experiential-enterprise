import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceNotFoundError } from "@/lib/errors";

const getModelDetail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/data-source", () => ({
  getCatalogDataSource: () => ({ getModelDetail })
}));

import { GET as readModel } from "@/app/api/models/[modelSlug]/route";

const context = { params: Promise.resolve({ modelSlug: "gpt-5.5" }) };

function request(query: string) {
  const value = new Request(`http://localhost/api/models/gpt-5.5${query}`);
  Object.defineProperty(value, "nextUrl", { value: new URL(value.url) });
  return value;
}

const detail = {
  model: { id: "model-uuid", slug: "gpt-5.5", display_name: "GPT-5.5" },
  providers: [],
  default_waterfall: []
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/models/[modelSlug]", () => {
  it("relays the public catalog read without requiring a session", async () => {
    getModelDetail.mockResolvedValue(detail);

    const response = await readModel(request("") as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(detail);
    expect(getModelDetail).toHaveBeenCalledWith("gpt-5.5", undefined);
  });

  it("pins the org's slug namespace when an orgId is given", async () => {
    getModelDetail.mockResolvedValue(detail);

    const response = await readModel(request("?orgId=org-uuid") as never, context);

    expect(response.status).toBe(200);
    expect(getModelDetail).toHaveBeenCalledWith("gpt-5.5", "org-uuid");
  });

  it("forwards the backend's self-correcting 404", async () => {
    getModelDetail.mockRejectedValue(new DataSourceNotFoundError("model 'gpt-5.5' not found"));

    const response = await readModel(request("") as never, context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "model 'gpt-5.5' not found" });
  });
});
