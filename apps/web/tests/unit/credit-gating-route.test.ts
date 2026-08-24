import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const getCreditGating = vi.hoisted(() => vi.fn());
const putPreVerifyAllowance = vi.hoisted(() => vi.fn());
const putWelcomeGrant = vi.hoisted(() => vi.fn());
const putYcGrant = vi.hoisted(() => vi.fn());
const putSpendUnlockRequirement = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({
    getCreditGating,
    putPreVerifyAllowance,
    putWelcomeGrant,
    putYcGrant,
    putSpendUnlockRequirement
  })
}));

import { GET } from "@/app/api/admin/settings/credit-gating/route";
import { PUT as putPreVerify } from "@/app/api/admin/settings/pre-verify-allowance/route";
import { PUT as putSpendUnlock } from "@/app/api/admin/settings/spend-unlock-requirement/route";
import { PUT as putWelcome } from "@/app/api/admin/settings/welcome-grant/route";
import { PUT as putYc } from "@/app/api/admin/settings/yc-grant/route";

const SETTINGS = {
  welcome_grant_micro_usd: 20_000_000,
  yc_grant_micro_usd: 526_000_000,
  pre_verify_allowance_micro_usd: 1_000_000,
  pre_verify_enabled: true,
  spend_unlock_requirement: "email"
};

function putReq(body: unknown): Request {
  return new Request("https://platform.example/api/admin/settings/x", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT"
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  getCreditGating.mockResolvedValue(SETTINGS);
  putPreVerifyAllowance.mockResolvedValue({ ...SETTINGS, pre_verify_enabled: false });
  putWelcomeGrant.mockResolvedValue({ ...SETTINGS, welcome_grant_micro_usd: 40_000_000 });
  putYcGrant.mockResolvedValue({ ...SETTINGS, yc_grant_micro_usd: 750_000_000 });
  putSpendUnlockRequirement.mockResolvedValue({ ...SETTINGS, spend_unlock_requirement: "card" });
});

describe("GET /api/admin/settings/credit-gating", () => {
  it("returns the consolidated settings for a platform admin", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SETTINGS);
  });

  it("hides the endpoint from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(getCreditGating).not.toHaveBeenCalled();
  });
});

describe("PUT knobs", () => {
  it("toggles the pre-verify allowance", async () => {
    const response = await putPreVerify(putReq({ enabled: false }) as never);
    expect(response.status).toBe(200);
    expect((await response.json()).pre_verify_enabled).toBe(false);
    expect(putPreVerifyAllowance).toHaveBeenCalledWith(false);
  });

  it("rejects a non-boolean pre-verify body", async () => {
    const response = await putPreVerify(putReq({ enabled: "yes" }) as never);
    expect(response.status).toBe(400);
    expect(putPreVerifyAllowance).not.toHaveBeenCalled();
  });

  it("sets the welcome grant amount", async () => {
    const response = await putWelcome(putReq({ micro_usd: 40_000_000 }) as never);
    expect(response.status).toBe(200);
    expect(putWelcomeGrant).toHaveBeenCalledWith(40_000_000);
  });

  it("sets the YC grant amount", async () => {
    const response = await putYc(putReq({ micro_usd: 750_000_000 }) as never);
    expect(response.status).toBe(200);
    expect(putYcGrant).toHaveBeenCalledWith(750_000_000);
  });

  it("rejects a negative or non-integer grant amount", async () => {
    expect((await putWelcome(putReq({ micro_usd: -5 }) as never)).status).toBe(400);
    expect((await putYc(putReq({ micro_usd: 1.5 }) as never)).status).toBe(400);
    expect(putWelcomeGrant).not.toHaveBeenCalled();
    expect(putYcGrant).not.toHaveBeenCalled();
  });

  it("sets the spend-unlock requirement", async () => {
    const response = await putSpendUnlock(putReq({ requirement: "card" }) as never);
    expect(response.status).toBe(200);
    expect(putSpendUnlockRequirement).toHaveBeenCalledWith("card");
  });

  it("rejects an unknown spend-unlock requirement", async () => {
    const response = await putSpendUnlock(putReq({ requirement: "sms" }) as never);
    expect(response.status).toBe(400);
    expect(putSpendUnlockRequirement).not.toHaveBeenCalled();
  });

  it("hides every write from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    expect((await putPreVerify(putReq({ enabled: false }) as never)).status).toBe(404);
    expect((await putWelcome(putReq({ micro_usd: 1 }) as never)).status).toBe(404);
    expect((await putYc(putReq({ micro_usd: 1 }) as never)).status).toBe(404);
    expect((await putSpendUnlock(putReq({ requirement: "card" }) as never)).status).toBe(404);
    expect(putWelcomeGrant).not.toHaveBeenCalled();
  });
});
