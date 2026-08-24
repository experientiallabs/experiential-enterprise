import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditLogPanel } from "@/components/settings/AuditLogPanel";
import type { AuditLogEvent, AuditLogList } from "@/lib/audit-log";

function makeEvent(overrides: Partial<AuditLogEvent>): AuditLogEvent {
  return {
    event_id: "ev-1",
    org_id: "org-1",
    actor_kind: "user",
    actor_id: "u1",
    action: "keys.mint",
    object_type: "api_key",
    object_id: "k1",
    before: null,
    after: { name: "prod" },
    context: {},
    created_at: "2026-08-20T10:00:00Z",
    ...overrides
  };
}

const LIST: AuditLogList = {
  org_id: "org-1",
  events: [
    makeEvent({}),
    makeEvent({
      event_id: "ev-2",
      actor_kind: "platform_admin",
      actor_id: "u2",
      action: "members.remove",
      object_type: "member",
      object_id: "u9",
      after: null,
      created_at: "2026-08-20T09:00:00Z"
    })
  ]
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(payload: unknown = LIST): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AuditLogPanel", () => {
  it("fetches the org's audit log and renders time, actor, action, and object rows", async () => {
    const fetchMock = stubFetch();
    render(<AuditLogPanel orgId="org-1" />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/orgs/org-1/audit-log?limit=50")
    );
    // Role-scoped: the filter dropdowns list the same action/object names.
    expect(await screen.findByRole("cell", { name: "keys.mint" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /u1 \(user\)/ })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /api_key k1/ })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "members.remove" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /u2 \(platform_admin\)/ })).toBeInTheDocument();
  });

  it("refetches with the action and object-type filters on the query string", async () => {
    const fetchMock = stubFetch();
    render(<AuditLogPanel orgId="org-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Filter by action"), {
      target: { value: "keys.rotate" }
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/orgs/org-1/audit-log?action=keys.rotate&limit=50"
      )
    );

    fireEvent.change(screen.getByLabelText("Filter by object type"), {
      target: { value: "api_key" }
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/orgs/org-1/audit-log?action=keys.rotate&object_type=api_key&limit=50"
      )
    );
  });

  it("pages backwards through time with the oldest loaded timestamp as the cursor", async () => {
    // A full page (limit-many events) signals older events may exist.
    const fullPage: AuditLogList = {
      org_id: "org-1",
      events: Array.from({ length: 50 }, (_, index) =>
        makeEvent({
          event_id: `ev-${index}`,
          created_at: `2026-08-20T10:00:${String(59 - index).padStart(2, "0")}Z`
        })
      )
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(fullPage)))
      .mockResolvedValueOnce(new Response(JSON.stringify(LIST)));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuditLogPanel orgId="org-1" />);

    const loadOlder = await screen.findByRole("button", { name: "Load older events" });
    fireEvent.click(loadOlder);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/orgs/org-1/audit-log?before=${encodeURIComponent("2026-08-20T10:00:10Z")}&limit=50`
      )
    );
    // The older page appends; a short page ends the cursor.
    expect(await screen.findByRole("cell", { name: "members.remove" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older events" })).not.toBeInTheDocument();
  });

  it("links the CSV download to the same filtered listing with format=csv", async () => {
    stubFetch();
    render(<AuditLogPanel orgId="org-1" />);

    const link = screen.getByRole("link", { name: "Download CSV" });
    expect(link).toHaveAttribute("href", "/api/orgs/org-1/audit-log?format=csv");

    fireEvent.change(screen.getByLabelText("Filter by action"), {
      target: { value: "keys.mint" }
    });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
        "href",
        "/api/orgs/org-1/audit-log?action=keys.mint&format=csv"
      )
    );
  });

  it("shows the empty state when no events exist", async () => {
    stubFetch({ org_id: "org-1", events: [] });
    render(<AuditLogPanel orgId="org-1" />);

    expect(await screen.findByText(/No audit events yet/)).toBeInTheDocument();
  });

  it("surfaces a load failure inline", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "Not allowed" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuditLogPanel orgId="org-1" />);

    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
  });
});
