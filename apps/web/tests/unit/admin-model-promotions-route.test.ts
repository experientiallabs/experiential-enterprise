import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const listAdminModelPromotions = vi.hoisted(() => vi.fn());
const createAdminModelPromotion = vi.hoisted(() => vi.fn());
const updateAdminModelPromotion = vi.hoisted(() => vi.fn());
const deleteAdminModelPromotion = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/data-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-source")>("@/lib/data-source");
  return {
    ...actual,
    getDataSource: () => ({
      listAdminModelPromotions,
      createAdminModelPromotion,
      updateAdminModelPromotion,
      deleteAdminModelPromotion,
    }),
  };
});

import { GET, POST } from "@/app/api/admin/model-promotions/route";
import { DELETE, PUT } from "@/app/api/admin/model-promotions/[id]/route";

const PROMO_ID = "0c8f2c66-58f8-4c33-9e01-9a56f7e3f001";

const CREATE_BODY = {
  label: "Qwen launch",
  model_slugs: ["qwen3.8-27b"],
  family_keys: ["qwen"],
  providers: [],
  audience_labels: ["yc"],
  funding_scope: "platform_funded",
  per_org_cap_micro_usd: 10_000_000,
  discount_cap_micro_usd: 0,
  cap_scope: "lifetime",
  percent_off: 25,
  active: true,
  display_order: 1,
};

const PROMO = { id: PROMO_ID, ...CREATE_BODY };

function postRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/admin/model-promotions", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  }) as unknown as NextRequest;
}

function putRequest(body: unknown): NextRequest {
  return new Request(`http://localhost/api/admin/model-promotions/${PROMO_ID}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  }) as unknown as NextRequest;
}

function deleteRequest(): NextRequest {
  return new Request(`http://localhost/api/admin/model-promotions/${PROMO_ID}`, {
    method: "DELETE",
  }) as unknown as NextRequest;
}

const idContext = { params: Promise.resolve({ id: PROMO_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  listAdminModelPromotions.mockResolvedValue([PROMO]);
  createAdminModelPromotion.mockResolvedValue(PROMO);
  updateAdminModelPromotion.mockResolvedValue(PROMO);
  deleteAdminModelPromotion.mockResolvedValue(undefined);
});

describe("the admin model-promotions routes", () => {
  it("lists promotions for a platform admin", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ promotions: [PROMO] });
  });

  it("is a not-found for a non-admin and reads nothing", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(listAdminModelPromotions).not.toHaveBeenCalled();
  });

  it("creates a promotion from a valid v2 body", async () => {
    const response = await POST(postRequest(CREATE_BODY));
    expect(response.status).toBe(201);
    expect(createAdminModelPromotion).toHaveBeenCalledWith(CREATE_BODY);
  });

  it("accepts an empty slug list when a provider scopes the promotion", async () => {
    const body = {
      ...CREATE_BODY,
      model_slugs: [],
      family_keys: [],
      providers: ["experiential_cloud"],
    };
    const response = await POST(postRequest(body));
    expect(response.status).toBe(201);
    expect(createAdminModelPromotion).toHaveBeenCalledWith(body);
  });

  it("rejects a body with neither model_slugs nor providers (scope required)", async () => {
    const response = await POST(
      postRequest({ ...CREATE_BODY, model_slugs: [], providers: [] })
    );
    expect(response.status).toBe(400);
    expect(createAdminModelPromotion).not.toHaveBeenCalled();
  });

  it("rejects an empty label with 400 and never writes", async () => {
    const response = await POST(postRequest({ ...CREATE_BODY, label: "  " }));
    expect(response.status).toBe(400);
    expect(createAdminModelPromotion).not.toHaveBeenCalled();
  });

  it("rejects a bad cap_scope with 400 and never writes", async () => {
    const response = await POST(postRequest({ ...CREATE_BODY, cap_scope: "weekly" }));
    expect(response.status).toBe(400);
    expect(createAdminModelPromotion).not.toHaveBeenCalled();
  });

  it("rejects a negative discount cap and a non-integer free cap", async () => {
    expect(
      (await POST(postRequest({ ...CREATE_BODY, discount_cap_micro_usd: -1 }))).status
    ).toBe(400);
    expect(
      (await POST(postRequest({ ...CREATE_BODY, per_org_cap_micro_usd: 0.5 }))).status
    ).toBe(400);
    expect(createAdminModelPromotion).not.toHaveBeenCalled();
  });

  it("rejects a percent_off outside 0-100", async () => {
    const response = await POST(postRequest({ ...CREATE_BODY, percent_off: 120 }));
    expect(response.status).toBe(400);
    expect(createAdminModelPromotion).not.toHaveBeenCalled();
  });

  it("rejects a model_slugs list that is not all strings", async () => {
    const response = await POST(postRequest({ ...CREATE_BODY, model_slugs: ["ok", 3] }));
    expect(response.status).toBe(400);
    expect(createAdminModelPromotion).not.toHaveBeenCalled();
  });

  it("refuses to create for a non-admin", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await POST(postRequest(CREATE_BODY));
    expect(response.status).toBe(404);
    expect(createAdminModelPromotion).not.toHaveBeenCalled();
  });

  it("updates a promotion by id with a full-resource body", async () => {
    const body = { ...CREATE_BODY, percent_off: 40, active: false };
    const response = await PUT(putRequest(body), idContext);
    expect(response.status).toBe(200);
    expect(updateAdminModelPromotion).toHaveBeenCalledWith(PROMO_ID, body);
  });

  it("rejects an invalid update body before proxying", async () => {
    const response = await PUT(
      putRequest({ ...CREATE_BODY, model_slugs: [], providers: [] }),
      idContext
    );
    expect(response.status).toBe(400);
    expect(updateAdminModelPromotion).not.toHaveBeenCalled();
  });

  it("deletes a promotion by id for an admin", async () => {
    const response = await DELETE(deleteRequest(), idContext);
    expect(response.status).toBe(200);
    expect(deleteAdminModelPromotion).toHaveBeenCalledWith(PROMO_ID);
  });

  it("refuses to delete for a non-admin", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await DELETE(deleteRequest(), idContext);
    expect(response.status).toBe(404);
    expect(deleteAdminModelPromotion).not.toHaveBeenCalled();
  });
});
