import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const listAdminExperientialCloud = vi.hoisted(() => vi.fn());
const createAdminExperientialCloud = vi.hoisted(() => vi.fn());
const updateAdminExperientialCloud = vi.hoisted(() => vi.fn());
const setAdminExperientialCloudStatus = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/data-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-source")>("@/lib/data-source");
  return {
    ...actual,
    getDataSource: () => ({
      listAdminExperientialCloud,
      createAdminExperientialCloud,
      updateAdminExperientialCloud,
      setAdminExperientialCloudStatus
    })
  };
});

import { GET, POST } from "@/app/api/admin/experiential-cloud/route";
import { PATCH } from "@/app/api/admin/experiential-cloud/[id]/route";
import { POST as STATUS_POST } from "@/app/api/admin/experiential-cloud/[id]/status/route";

const EC_ID = "11111111-1111-1111-1111-111111111111";

function jsonRequest(url: string, method: string, body: unknown): NextRequest {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  }) as unknown as NextRequest;
}

function idContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("admin experiential-cloud routes", () => {
  it("GET is a not-found for a non-admin and never reads the data source", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(listAdminExperientialCloud).not.toHaveBeenCalled();
  });

  it("GET returns the list envelope for an admin", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    listAdminExperientialCloud.mockResolvedValue({
      deployments: [],
      worker_base_url_configured: false
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deployments: [], worker_base_url_configured: false });
  });

  it("POST creates a lane (201) and defaults OFF by omitting status", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    createAdminExperientialCloud.mockResolvedValue({ slug: "deepseek-v4-flash" });
    const response = await POST(
      jsonRequest("http://localhost/api/admin/experiential-cloud", "POST", {
        slug: "deepseek-v4-flash",
        provider_model_id: "deepseek-v4-flash",
        input_micro_usd_per_million: 42448
      })
    );
    expect(response.status).toBe(201);
    expect(createAdminExperientialCloud).toHaveBeenCalledWith({
      slug: "deepseek-v4-flash",
      provider_model_id: "deepseek-v4-flash",
      base_url: undefined,
      pricing_source: undefined,
      input_micro_usd_per_million: 42448
    });
  });

  it("POST passes status active through when chosen", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    createAdminExperientialCloud.mockResolvedValue({});
    await POST(
      jsonRequest("http://localhost/api/admin/experiential-cloud", "POST", {
        slug: "qwen3.8-27b",
        provider_model_id: "qwen3.8-27b",
        status: "active"
      })
    );
    expect(createAdminExperientialCloud).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" })
    );
  });

  it("POST rejects a missing slug with a 400 and no data-source call", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    const response = await POST(
      jsonRequest("http://localhost/api/admin/experiential-cloud", "POST", {
        provider_model_id: "x"
      })
    );
    expect(response.status).toBe(400);
    expect(createAdminExperientialCloud).not.toHaveBeenCalled();
  });

  it("POST rejects a negative price with a 400", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    const response = await POST(
      jsonRequest("http://localhost/api/admin/experiential-cloud", "POST", {
        slug: "deepseek-v4-flash",
        provider_model_id: "deepseek-v4-flash",
        input_micro_usd_per_million: -1
      })
    );
    expect(response.status).toBe(400);
    expect(createAdminExperientialCloud).not.toHaveBeenCalled();
  });

  it("POST is a not-found for a non-admin", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await POST(
      jsonRequest("http://localhost/api/admin/experiential-cloud", "POST", {
        slug: "x",
        provider_model_id: "y"
      })
    );
    expect(response.status).toBe(404);
    expect(createAdminExperientialCloud).not.toHaveBeenCalled();
  });

  it("PATCH updates hookup info for an admin", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    updateAdminExperientialCloud.mockResolvedValue({});
    const response = await PATCH(
      jsonRequest(`http://localhost/api/admin/experiential-cloud/${EC_ID}`, "PATCH", {
        provider_model_id: "deepseek-v4-flash-r2",
        base_url: "https://vllm-2:8000/v1"
      }),
      idContext(EC_ID)
    );
    expect(response.status).toBe(200);
    expect(updateAdminExperientialCloud).toHaveBeenCalledWith(EC_ID, {
      provider_model_id: "deepseek-v4-flash-r2",
      base_url: "https://vllm-2:8000/v1",
      pricing_source: undefined
    });
  });

  it("PATCH is a not-found for a non-admin", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await PATCH(
      jsonRequest(`http://localhost/api/admin/experiential-cloud/${EC_ID}`, "PATCH", {
        provider_model_id: "x"
      }),
      idContext(EC_ID)
    );
    expect(response.status).toBe(404);
    expect(updateAdminExperientialCloud).not.toHaveBeenCalled();
  });

  it("status POST toggles for an admin", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    setAdminExperientialCloudStatus.mockResolvedValue({});
    const response = await STATUS_POST(
      jsonRequest(`http://localhost/api/admin/experiential-cloud/${EC_ID}/status`, "POST", {
        status: "active"
      }),
      idContext(EC_ID)
    );
    expect(response.status).toBe(200);
    expect(setAdminExperientialCloudStatus).toHaveBeenCalledWith(EC_ID, "active");
  });

  it("status POST rejects an unknown status with a 400", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    const response = await STATUS_POST(
      jsonRequest(`http://localhost/api/admin/experiential-cloud/${EC_ID}/status`, "POST", {
        status: "hidden"
      }),
      idContext(EC_ID)
    );
    expect(response.status).toBe(400);
    expect(setAdminExperientialCloudStatus).not.toHaveBeenCalled();
  });

  it("status POST is a not-found for a non-admin", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await STATUS_POST(
      jsonRequest(`http://localhost/api/admin/experiential-cloud/${EC_ID}/status`, "POST", {
        status: "active"
      }),
      idContext(EC_ID)
    );
    expect(response.status).toBe(404);
    expect(setAdminExperientialCloudStatus).not.toHaveBeenCalled();
  });
});
