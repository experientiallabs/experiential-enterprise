import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendDataSource } from "@/lib/backend-source";
import { DataSourceNotFoundError, DataSourceRequestError } from "@/lib/errors";
const TEST_ACTOR = async () => "user-1";

describe("BackendDataSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches org lists from the configured backend", async () => {
    const org = {
      id: "00000000-0000-0000-0000-000000000002",
      slug: "demo",
      name: "Demo",
      role: "admin"
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify([org]), { status: 200 }));
    const dataSource = new BackendDataSource("http://127.0.0.1:8030/", "test-api-key", TEST_ACTOR);

    const orgs = await dataSource.listOrgs();

    expect(orgs).toEqual([org]);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8030/api/orgs", {
      body: undefined,
      cache: "no-store",
      headers: { Authorization: "Bearer test-api-key", "X-Explabs-Actor-Id": "user-1" },
      method: "GET"
    });
  });

  it("maps backend 404s to data-source not-found errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Project not found: missing" }), { status: 404 })
    );
    const dataSource = new BackendDataSource("http://127.0.0.1:8030", "test-api-key", TEST_ACTOR);

    await expect(dataSource.getProject("missing")).rejects.toThrow(DataSourceNotFoundError);
  });

  it("preserves non-404 upstream statuses as request errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Project setup version conflict" }), {
        status: 409
      })
    );
    const dataSource = new BackendDataSource("http://127.0.0.1:8030", "test-api-key", TEST_ACTOR);

    const failure = dataSource.archiveProject("project-1");
    await expect(failure).rejects.toBeInstanceOf(DataSourceRequestError);
    await failure.catch((error: DataSourceRequestError) => {
      expect(error.status).toBe(409);
      expect(error.message).toBe("Project setup version conflict");
    });
  });

  it("preserves stable Project rejection metadata across the backend boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          action: "add_credit",
          code: "insufficient_credit",
          error: "Add Platform credit before optimization"
        }),
        { status: 402 }
      )
    );
    const dataSource = new BackendDataSource(
      "http://127.0.0.1:8030",
      "test-api-key",
      TEST_ACTOR
    );

    const failure = dataSource.enqueueProjectJob("project-1");
    await failure.catch((error: DataSourceRequestError) => {
      expect(error.status).toBe(402);
      expect(error.code).toBe("insufficient_credit");
      expect(error.action).toBe("add_credit");
    });
  });

  it("cancels Project jobs only through the dedicated backend route", async () => {
    const cancelled = { id: "job-1", status: "cancelled" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(cancelled), { status: 200 }));
    const dataSource = new BackendDataSource(
      "http://127.0.0.1:8030",
      "test-api-key",
      TEST_ACTOR
    );

    await expect(dataSource.cancelProjectJob("job-1")).resolves.toEqual(cancelled);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8030/api/project-jobs/job-1/cancel",
      expect.objectContaining({ body: JSON.stringify({}), method: "POST" })
    );
  });

  it("pages Projects explicitly and resolves slug detail without a list scan", async () => {
    const page = { limit: 24, offset: 96, projects: [], total: 101 };
    const project = { id: "project-101", slug: "project-101" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(project), { status: 200 }));
    const dataSource = new BackendDataSource(
      "http://127.0.0.1:8030",
      "test-api-key",
      TEST_ACTOR
    );

    await expect(
      dataSource.listProjects("org-1", {
        includeArchived: true,
        limit: 24,
        offset: 96
      })
    ).resolves.toEqual(page);
    await expect(dataSource.getProjectBySlug("org-1", "project-101")).resolves.toEqual(project);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8030/api/orgs/org-1/projects?include_archived=true&limit=24&offset=96"
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:8030/api/orgs/org-1/projects/project-101"
    );
  });

  it("fetches the lightweight organization budget", async () => {
    const budget = { spend_usd: 7.125, usage_limit_usd: 20 };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(budget), { status: 200 }));
    const dataSource = new BackendDataSource("http://127.0.0.1:8030", "test-api-key", TEST_ACTOR);

    expect(await dataSource.getOrgBudget("org-1")).toEqual(budget);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8030/api/orgs/org-1/budget",
      expect.objectContaining({ cache: "no-store", method: "GET" })
    );
  });

  it("requires a backend URL", () => {
    expect(() => new BackendDataSource("", "test-api-key", TEST_ACTOR)).toThrow(
      /EXPLABS_BACKEND_URL/
    );
  });

  it("requires a backend API key", () => {
    expect(() => new BackendDataSource("http://127.0.0.1:8030", "", TEST_ACTOR)).toThrow(
      /EXPLABS_API_KEY/
    );
  });
});
