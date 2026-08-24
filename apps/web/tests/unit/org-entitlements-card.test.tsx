import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrgEntitlementsCard } from "@/components/admin/OrgEntitlementsCard";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function listResponse(entitlements: unknown[]) {
  return { ok: true, json: async () => ({ org_id: "org-1", entitlements }) };
}

describe("OrgEntitlementsCard", () => {
  it("renders all five capabilities with grant buttons when none are granted", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([]));
    render(<OrgEntitlementsCard orgId="org-1" />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Grant" })).toHaveLength(5));
    expect(screen.getByText("Domains & SSO")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("shows Revoke for a granted capability and grants through the admin route", async () => {
    fetchMock
      .mockResolvedValueOnce(
        listResponse([{ capability: "teams", granted_by: null, note: null, created_at: null, expires_at: null }])
      )
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce(
        listResponse([
          { capability: "teams", granted_by: null, note: null, created_at: null, expires_at: null },
          { capability: "audit_log", granted_by: null, note: null, created_at: null, expires_at: null }
        ])
      );
    render(<OrgEntitlementsCard orgId="org-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Grant" })[0]);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/orgs/org-1/entitlements/audit_log",
        expect.objectContaining({ method: "PUT" })
      )
    );
  });

  it("treats an expired grant as not active", async () => {
    fetchMock.mockResolvedValueOnce(
      listResponse([
        {
          capability: "scim",
          granted_by: null,
          note: null,
          created_at: null,
          expires_at: "2020-01-01T00:00:00Z"
        }
      ])
    );
    render(<OrgEntitlementsCard orgId="org-1" />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Grant" })).toHaveLength(5));
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});
