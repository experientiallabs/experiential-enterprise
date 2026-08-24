import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());
const getDataSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", () => ({ getDataSource }));

import { DELETE } from "@/app/api/orgs/[orgId]/data/route";

const context = { params: Promise.resolve({ orgId: "org-1" }) };
const request = new Request("https://platform.example/api/orgs/org-1/data", {
  method: "DELETE"
});

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrgId.mockResolvedValue("org-1");
  isPlatformAdmin.mockResolvedValue(false);
});

describe("DELETE /api/orgs/[orgId]/data", () => {
  it("hides the wipe from non-admin members", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await DELETE(request as never, context);

    expect(response.status).toBe(404);
  });

  it("deletes every world model through the backend and clears telemetry", async () => {
    isOrgAdmin.mockResolvedValue(true);
    const deleteOrgData = vi.fn().mockResolvedValue({ deleted_world_models: 2 });
    getDataSource.mockReturnValue({ deleteOrgData });
    const deletedTables: string[] = [];
    const removedObjects: string[][] = [];
    const rpc = vi.fn(async () => ({ error: null }));
    createServiceRoleSupabaseClient.mockReturnValue({
      rpc,
      from: (table: string) => ({
        delete: () => ({
          eq: async (column: string, value: string) => {
            expect(column).toBe("org_id");
            expect(value).toBe("org-1");
            deletedTables.push(table);
            return { error: null };
          }
        }),
        select: () => ({
          eq: async () => ({
            data: [
              { upload_path: "trace-ingests/a/upload.jsonl", result_path: "trace-ingests/a/result.jsonl" },
              { upload_path: null, result_path: null }
            ],
            error: null
          })
        })
      }),
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            expect(bucket).toBe("explabs-artifacts");
            removedObjects.push(paths);
            return { data: null, error: null };
          }
        })
      }
    });

    const response = await DELETE(request as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted_world_models: 2 });
    expect(deleteOrgData).toHaveBeenCalledTimes(1);
    expect(deleteOrgData).toHaveBeenCalledWith("org-1");
    expect(deletedTables).toEqual([
      "telemetry_span_sets",
      "telemetry_spans",
      "gateway_captured_prompts",
      "trace_ingests"
    ]);
    expect(removedObjects).toEqual([
      ["trace-ingests/a/upload.jsonl", "trace-ingests/a/result.jsonl"]
    ]);
    // No ledger writes here: the database keeps billable_spend_usd intact on
    // deletes, so the wipe needs no compensation (and cannot race one).
    // And NO web-side audit emit: the backend's org-data handler (which
    // deleteOrgData proxies to) already records org.data_delete — a second
    // emit here would double-count every wipe.
    expect(rpc).not.toHaveBeenCalled();
  });
});
