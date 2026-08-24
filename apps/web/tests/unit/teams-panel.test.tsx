import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamsPanel } from "@/components/settings/TeamsPanel";
import type { Team } from "@/lib/teams";

const TEAM_PLATFORM: Team = {
  team_id: "team-1",
  org_id: "org-1",
  name: "Platform",
  created_by: "user-admin",
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z",
  member_count: 1,
  key_count: 1,
  assigned_key_ids: ["key-1"]
};

const TEAM_RESEARCH: Team = {
  team_id: "team-2",
  org_id: "org-1",
  name: "Research",
  created_by: null,
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z",
  member_count: 0,
  key_count: 0,
  assigned_key_ids: []
};

type FetchCall = { url: string; method: string; body: unknown };

/**
 * A fetch stand-in covering the panel's four reads and its mutations, with a
 * mutable team list so a post-mutation reload observably changes the render.
 */
function stubBackend(initialTeams: Team[]) {
  const calls: FetchCall[] = [];
  let teams = [...initialTeams];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));
    calls.push({ url, method, body });
    const respond = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200 });
    if (url === "/api/orgs/org-1/teams" && method === "GET") {
      return respond({ org_id: "org-1", teams });
    }
    if (url === "/api/orgs/org-1/teams" && method === "POST") {
      const created: Team = {
        ...TEAM_RESEARCH,
        team_id: "team-new",
        name: String((body as { name: string }).name),
      };
      teams = [...teams, created];
      return respond(created);
    }
    if (url === "/api/orgs/org-1/members") {
      return respond({
        members: [
          { userId: "user-admin", email: "admin@acme.test" },
          { userId: "user-dev", email: "dev@acme.test" }
        ]
      });
    }
    if (url === "/api/keys?orgId=org-1&page=1") {
      return respond({
        keys: [
          { id: "key-1", name: "prod key", key_prefix: "xpl_prod", revoked_at: null },
          { id: "key-2", name: "dev key", key_prefix: "xpl_dev1", revoked_at: null }
        ],
        page: 1,
        pageCount: 1
      });
    }
    if (url === "/api/orgs/org-1/teams/team-1/members" && method === "GET") {
      return respond({
        members: [
          {
            team_id: "team-1",
            user_id: "user-admin",
            added_by: null,
            created_at: "2026-08-20T00:00:00Z"
          }
        ]
      });
    }
    if (url === "/api/orgs/org-1/teams/team-1/keys/key-1" && method === "DELETE") {
      teams = teams.map((team) =>
        team.team_id === "team-1" ? { ...team, key_count: 0, assigned_key_ids: [] } : team
      );
      return respond({ api_key_id: "key-1", team_id: null });
    }
    if (url === "/api/orgs/org-1/teams/team-1?force=true" && method === "DELETE") {
      teams = teams.filter((team) => team.team_id !== "team-1");
      return respond({ team_id: "team-1", deleted: true, unassigned_key_count: 1 });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TeamsPanel", () => {
  it("lists teams with member and key counts", async () => {
    stubBackend([TEAM_PLATFORM, TEAM_RESEARCH]);
    render(<TeamsPanel orgId="org-1" canManage />);
    expect(await screen.findByText("Platform")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("1 member · 1 key")).toBeInTheDocument();
    expect(screen.getByText("0 members · 0 keys")).toBeInTheDocument();
  });

  it("creates a team and shows it after the reload", async () => {
    const { calls } = stubBackend([]);
    render(<TeamsPanel orgId="org-1" canManage />);
    const input = await screen.findByLabelText("New team name");
    fireEvent.change(input, { target: { value: "Data" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    expect(await screen.findByText("Data")).toBeInTheDocument();
    const create = calls.find((call) => call.method === "POST");
    expect(create).toMatchObject({ url: "/api/orgs/org-1/teams", body: { name: "Data" } });
  });

  it("expands a team into member management and key unassignment", async () => {
    const { calls } = stubBackend([TEAM_PLATFORM, TEAM_RESEARCH]);
    render(<TeamsPanel orgId="org-1" canManage />);
    fireEvent.click(await screen.findByLabelText("Toggle Platform details"));
    // The Remove control only exists on a loaded member row, so it anchors
    // the wait (the same email transiently appears as an add-member option
    // before the team roster resolves). The roster join renders the email,
    // and the assigned key shows with its unassign control.
    await screen.findByRole("button", { name: "Remove" });
    expect(screen.getByText("admin@acme.test")).toBeInTheDocument();
    expect(screen.getByText("prod key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unassign" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "DELETE" && call.url === "/api/orgs/org-1/teams/team-1/keys/key-1"
        )
      ).toBe(true)
    );
    expect(await screen.findByText("1 member · 0 keys")).toBeInTheDocument();
  });

  it("confirms deletion, warning about assigned keys, and forces the detach", async () => {
    const { calls } = stubBackend([TEAM_PLATFORM]);
    render(<TeamsPanel orgId="org-1" canManage />);
    await screen.findByText("Platform");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/unassigns its/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete team" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "DELETE" && call.url === "/api/orgs/org-1/teams/team-1?force=true"
        )
      ).toBe(true)
    );
    expect(await screen.findByText("No teams yet")).toBeInTheDocument();
  });

  it("renders read-only for members", async () => {
    stubBackend([TEAM_PLATFORM]);
    render(<TeamsPanel orgId="org-1" canManage={false} />);
    expect(await screen.findByText("Platform")).toBeInTheDocument();
    expect(screen.queryByLabelText("New team name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
  });
});
