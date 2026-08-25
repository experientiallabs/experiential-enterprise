import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const listAdminRecommendedModels = vi.hoisted(() => vi.fn());
const replaceAdminRecommendedModels = vi.hoisted(() => vi.fn());

const revalidateModelsCatalog = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/models-catalog/server", () => ({ revalidateModelsCatalog }));
vi.mock("@/lib/data-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-source")>("@/lib/data-source");
  return {
    ...actual,
    getDataSource: () => ({
      listAdminRecommendedModels,
      replaceAdminRecommendedModels,
    }),
  };
});

import { GET, PUT } from "@/app/api/admin/recommended-models/route";

const MODELS = [
  { slug: "ox-alpha", display_name: "Ox Alpha", preferred_rank: 0 },
  { slug: "claude-fable-5", display_name: "Claude Fable 5", preferred_rank: 1 },
];

function putRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/admin/recommended-models", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  listAdminRecommendedModels.mockResolvedValue(MODELS);
  replaceAdminRecommendedModels.mockResolvedValue(MODELS);
});

describe("the admin recommended-models routes", () => {
  it("lists the recommended set for a platform admin", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: MODELS });
  });

  it("is a not-found for a non-admin and reads nothing", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(listAdminRecommendedModels).not.toHaveBeenCalled();
  });

  it("replaces the whole set from an ordered slug list", async () => {
    const response = await PUT(putRequest({ slugs: ["ox-alpha", "claude-fable-5"] }));
    expect(response.status).toBe(200);
    expect(replaceAdminRecommendedModels).toHaveBeenCalledWith([
      "ox-alpha",
      "claude-fable-5",
    ]);
    expect(await response.json()).toEqual({ models: MODELS });
  });

  it("busts the shared catalog cache after a replace, never on a rejected body", async () => {
    await PUT(putRequest({ slugs: ["ox-alpha"] }));
    expect(revalidateModelsCatalog).toHaveBeenCalledTimes(1);
    revalidateModelsCatalog.mockClear();
    await PUT(putRequest({ slugs: [] }));
    expect(revalidateModelsCatalog).not.toHaveBeenCalled();
  });

  it("refuses to replace for a non-admin", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await PUT(putRequest({ slugs: ["ox-alpha"] }));
    expect(response.status).toBe(404);
    expect(replaceAdminRecommendedModels).not.toHaveBeenCalled();
  });

  it("rejects an empty list: the seed guard reads an unranked catalog as fresh", async () => {
    const response = await PUT(putRequest({ slugs: [] }));
    expect(response.status).toBe(400);
    expect(replaceAdminRecommendedModels).not.toHaveBeenCalled();
  });

  it("rejects duplicates: list order defines the rank", async () => {
    const response = await PUT(putRequest({ slugs: ["ox-alpha", "ox-alpha"] }));
    expect(response.status).toBe(400);
    expect(replaceAdminRecommendedModels).not.toHaveBeenCalled();
  });

  it("rejects a slugs list that is not all non-blank strings", async () => {
    expect((await PUT(putRequest({ slugs: ["ok", 3] }))).status).toBe(400);
    expect((await PUT(putRequest({ slugs: ["ok", " "] }))).status).toBe(400);
    expect((await PUT(putRequest({}))).status).toBe(400);
    expect((await PUT(putRequest(null))).status).toBe(400);
    expect(replaceAdminRecommendedModels).not.toHaveBeenCalled();
  });
});
