import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { recordAuditEvent, redactAuditValue, type AuditEvent } from "@/lib/audit";

const EVENT: AuditEvent = {
  orgId: "org-1",
  actorKind: "user",
  actorId: "user-1",
  action: "keys.mint",
  objectType: "api_key",
  objectId: "k1"
};

describe("recordAuditEvent", () => {
  it("maps the event onto the record_audit_event RPC parameters", async () => {
    const rpc = vi.fn(async () => ({ error: null }));

    await recordAuditEvent({ rpc } as unknown as SupabaseClient, {
      ...EVENT,
      before: { name: "old" },
      after: { name: "new" },
      context: { via: "device_activation" }
    });

    expect(rpc).toHaveBeenCalledWith("record_audit_event", {
      p_org_id: "org-1",
      p_actor_kind: "user",
      p_actor_id: "user-1",
      p_action: "keys.mint",
      p_object_type: "api_key",
      p_object_id: "k1",
      p_before: { name: "old" },
      p_after: { name: "new" },
      p_context: { via: "device_activation" }
    });
  });

  it("sends null for omitted snapshots rather than undefined", async () => {
    const rpc = vi.fn(async () => ({ error: null }));

    await recordAuditEvent({ rpc } as unknown as SupabaseClient, EVENT);

    expect(rpc).toHaveBeenCalledWith(
      "record_audit_event",
      expect.objectContaining({ p_before: null, p_after: null, p_context: null })
    );
  });

  // Audit failure must not fail the customer mutation (pre-launch decision):
  // by the time this runs the mutation has already committed.
  it("never throws when the RPC answers an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async () => ({ error: { message: "permission denied" } }));

    await expect(
      recordAuditEvent({ rpc } as unknown as SupabaseClient, EVENT)
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("keys.mint"));
    error.mockRestore();
  });

  it("never throws when the RPC rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(
      recordAuditEvent({ rpc } as unknown as SupabaseClient, EVENT)
    ).resolves.toBeUndefined();
    error.mockRestore();
  });

  it("never throws even against a client with no rpc at all", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordAuditEvent({} as SupabaseClient, EVENT)).resolves.toBeUndefined();
    error.mockRestore();
  });

  it("redacts secret-named keys from the snapshots it persists", async () => {
    const rpc = vi.fn(async () => ({ error: null }));

    await recordAuditEvent({ rpc } as unknown as SupabaseClient, {
      ...EVENT,
      after: { name: "prod", secret: "xpl_abc", key_hash: "deadbeef" }
    });

    expect(rpc).toHaveBeenCalledWith(
      "record_audit_event",
      expect.objectContaining({ p_after: { name: "prod" } })
    );
  });
});

describe("redactAuditValue", () => {
  it("strips secret/token/credential/password-named keys, case-insensitively", () => {
    expect(
      redactAuditValue({
        name: "prod",
        apiKeySecret: "xpl_abc",
        access_token: "t",
        Credential: "c",
        newPassword: "p",
        nested: { refreshToken: "r", kept: 1 }
      })
    ).toEqual({ name: "prod", nested: { kept: 1 } });
  });

  it("recurses through arrays and passes scalars through untouched", () => {
    expect(redactAuditValue([{ token: "t", id: 1 }, "plain", 3])).toEqual([{ id: 1 }, "plain", 3]);
    expect(redactAuditValue("string")).toBe("string");
    expect(redactAuditValue(null)).toBeNull();
  });
});
