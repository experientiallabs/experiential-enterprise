import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { AliasesPanel } from "@/components/settings/AliasesPanel";
import type { AliasModelOption, AliasRevision, NamedAlias } from "@/lib/aliases/types";

const MODELS: AliasModelOption[] = [
  { slug: "gpt-5", display_name: "GPT-5" },
  { slug: "claude-opus-5", display_name: "Claude Opus 5" }
];

const CODING: NamedAlias = {
  alias_id: "named-1",
  name: "coding",
  org_id: "org-1",
  active: true,
  current_revision_id: "nrev-1",
  target_model_slug: "gpt-5",
  target_model_id: "m-1"
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AliasesPanel", () => {
  it("lists aliases with their current target model", () => {
    render(<AliasesPanel aliases={[CODING]} models={MODELS} orgId="org-1" />);
    // "coding" also appears as the header's example alias; the row cell is
    // the listing under test.
    expect(screen.getByRole("cell", { name: "coding" })).toBeInTheDocument();
    expect(screen.getAllByText("gpt-5").length).toBeGreaterThan(0);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows an empty state when there are no aliases", () => {
    render(<AliasesPanel aliases={[]} models={MODELS} orgId="org-1" />);
    expect(screen.getByText(/No named aliases yet/)).toBeInTheDocument();
  });

  it("creates an alias through POST /api/aliases", async () => {
    const fetchMock = stubFetch();
    render(<AliasesPanel aliases={[]} models={MODELS} orgId="org-1" />);
    fireEvent.change(screen.getByLabelText("Alias name"), { target: { value: "fast" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/aliases");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ org_id: "org-1", name: "fast", model: "gpt-5" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("repoints an alias through PUT /api/aliases/{name}", async () => {
    const fetchMock = stubFetch();
    render(<AliasesPanel aliases={[CODING]} models={MODELS} orgId="org-1" />);
    fireEvent.change(screen.getByLabelText("Repoint coding"), {
      target: { value: "claude-opus-5" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Repoint" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/aliases/coding");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ org_id: "org-1", model: "claude-opus-5" });
  });

  it("rolls back through GET revisions then POST /api/aliases/{name}/rollback", async () => {
    // History opens with a GET that returns the repoint trail; rolling back a
    // prior revision then POSTs the rollback with that revision's id.
    const REVISIONS: AliasRevision[] = [
      {
        revision_id: "nrev-2",
        model_slug: "claude-opus-5",
        model_id: "m-2",
        is_current: true,
        created_at: "2026-08-19T00:00:00Z"
      },
      {
        revision_id: "nrev-1",
        model_slug: "gpt-5",
        model_id: "m-1",
        is_current: false,
        created_at: "2026-08-18T00:00:00Z"
      }
    ];
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        url.includes("/revisions")
          ? new Response(JSON.stringify({ name: "coding", alias_id: "named-1", revisions: REVISIONS }))
          : new Response(JSON.stringify({ ok: true }))
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AliasesPanel aliases={[CODING]} models={MODELS} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/aliases/coding/revisions?org_id=org-1")
    );
    fireEvent.click(await screen.findByRole("button", { name: "Roll back" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/aliases/coding/rollback",
        expect.objectContaining({ method: "POST" })
      )
    );
    const rollbackCall = fetchMock.mock.calls.find(([url]) => url === "/api/aliases/coding/rollback");
    expect(JSON.parse(String(rollbackCall![1]?.body))).toEqual({
      org_id: "org-1",
      revision_id: "nrev-1"
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("retires an alias through DELETE /api/aliases/{name} after a confirm", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    render(<AliasesPanel aliases={[CODING]} models={MODELS} orgId="org-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/aliases/coding?org_id=org-1");
    expect(init.method).toBe("DELETE");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("keeps every admin control in the single-card layout: create, repoint, history, retire", () => {
    // The access-control page redesign (2026-08-23) reflowed the panel into
    // one card; this pins that no capability was dropped in the reflow.
    stubFetch();
    render(<AliasesPanel aliases={[CODING]} models={MODELS} orgId="org-1" />);
    expect(screen.getByLabelText("Alias name")).toBeInTheDocument();
    expect(screen.getByLabelText("Backing model")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(screen.getByLabelText("Repoint coding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repoint" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retire" })).toBeInTheDocument();
  });

  it("tells the admin when no models are available to point at", () => {
    render(<AliasesPanel aliases={[]} models={[]} orgId="org-1" />);
    expect(screen.getByText(/No models are available/)).toBeInTheDocument();
  });
});
