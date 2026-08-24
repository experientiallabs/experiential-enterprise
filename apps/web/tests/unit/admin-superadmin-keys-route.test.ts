import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const revokeSuperadminKey = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/admin/superadmin-keys", () => ({
  revokeSuperadminKey
}));

import { DELETE } from "@/app/api/admin/superadmin-keys/[id]/route";

// Minting has no standalone route: keys are created only by the site-admin
// grant route (covered in admin-site-admin-route.test.ts). This file covers
// the revoke surface Admin > Access still exposes.

const KEY_ID = "5f0c66aa-0000-4000-8000-000000000001";

function deleteRequest(): NextRequest {
  return new Request(`http://localhost/api/admin/superadmin-keys/${KEY_ID}`, {
    method: "DELETE"
  }) as unknown as NextRequest;
}

const idContext = { params: Promise.resolve({ id: KEY_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  revokeSuperadminKey.mockResolvedValue(true);
});

describe("the admin superadmin-keys revoke route", () => {
  it("revokes a key by id", async () => {
    const response = await DELETE(deleteRequest(), idContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(revokeSuperadminKey).toHaveBeenCalledWith(KEY_ID);
  });

  it("404s an unknown key id", async () => {
    revokeSuperadminKey.mockResolvedValue(false);
    const response = await DELETE(deleteRequest(), idContext);
    expect(response.status).toBe(404);
  });

  it("404s a malformed (non-uuid) key id without touching the store", async () => {
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ id: "not-a-uuid" })
    });
    expect(response.status).toBe(404);
    expect(revokeSuperadminKey).not.toHaveBeenCalled();
  });

  it("refuses to revoke for a non-admin and never touches the key store", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await DELETE(deleteRequest(), idContext);
    expect(response.status).toBe(404);
    expect(revokeSuperadminKey).not.toHaveBeenCalled();
  });
});
