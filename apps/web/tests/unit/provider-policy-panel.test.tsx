import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderPolicyPanel } from "@/components/settings/ProviderPolicyPanel";
import type { ProviderDataControls, ProviderPolicy } from "@/lib/data-controls";

const MATRIX: ProviderDataControls[] = [
  {
    provider: "bedrock",
    zero_data_retention: true,
    no_training: true,
    source_note: "AWS Bedrock does not store prompts or completions.",
    updated_at: "2026-08-22T00:00:00Z"
  },
  {
    provider: "openai",
    zero_data_retention: false,
    no_training: true,
    source_note: "OpenAI retains API data up to 30 days by default.",
    updated_at: "2026-08-22T00:00:00Z"
  },
  {
    provider: "openrouter",
    zero_data_retention: false,
    no_training: false,
    source_note: "Aggregator; posture varies by downstream provider.",
    updated_at: "2026-08-22T00:00:00Z"
  }
];

const POLICY: ProviderPolicy = {
  org_id: "org-1",
  allowed_providers: ["bedrock", "openai"],
  require_zdr: false,
  require_no_training: true,
  created_by: "user-admin",
  updated_by: "user-admin",
  created_at: "2026-08-22T00:00:00Z",
  updated_at: "2026-08-22T00:00:00Z"
};

type FetchCall = { url: string; method: string; body: unknown };

/**
 * A fetch stand-in covering the panel's two reads and its mutations, with a
 * mutable policy so a post-mutation reload observably changes the render.
 */
function stubBackend(initialPolicy: ProviderPolicy | null) {
  const calls: FetchCall[] = [];
  let policy = initialPolicy;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));
    calls.push({ url, method, body });
    const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
    if (url === "/api/orgs/org-1/provider-data-controls" && method === "GET") {
      return respond({ providers: MATRIX });
    }
    if (url === "/api/orgs/org-1/provider-policy" && method === "GET") {
      return respond({ org_id: "org-1", policy });
    }
    if (url === "/api/orgs/org-1/provider-policy" && method === "PUT") {
      const input_ = body as {
        allowed_providers: string[] | null;
        require_zdr: boolean;
        require_no_training: boolean;
      };
      policy = {
        ...POLICY,
        allowed_providers: input_.allowed_providers,
        require_zdr: input_.require_zdr,
        require_no_training: input_.require_no_training
      };
      return respond({ org_id: "org-1", policy });
    }
    if (url === "/api/orgs/org-1/provider-policy" && method === "DELETE") {
      policy = null;
      return respond({ deleted: true });
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

describe("ProviderPolicyPanel", () => {
  it("renders the posture matrix with badges and source notes", async () => {
    stubBackend(null);
    render(<ProviderPolicyPanel orgId="org-1" canManage />);
    expect(await screen.findByText("bedrock")).toBeInTheDocument();
    expect(screen.getByText("openrouter")).toBeInTheDocument();
    // bedrock holds both guarantees; openrouter holds neither.
    expect(screen.getAllByText("Zero retention")).toHaveLength(1);
    expect(screen.getAllByText("No training")).toHaveLength(2);
    expect(screen.getAllByText("May retain")).toHaveLength(2);
    expect(screen.getByText("AWS Bedrock does not store prompts or completions.")).toBeInTheDocument();
    // No policy: "All providers" is the default state and there is nothing
    // to save or remove yet.
    expect(screen.getByLabelText("Allow all providers")).toBeChecked();
    expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove policy" })).not.toBeInTheDocument();
  });

  it("saves a tightened policy and reflects the stored document", async () => {
    const { calls } = stubBackend(null);
    render(<ProviderPolicyPanel orgId="org-1" canManage />);
    fireEvent.click(await screen.findByLabelText("Require zero-data-retention providers"));
    fireEvent.click(screen.getByLabelText("Allow all providers"));
    fireEvent.click(screen.getByLabelText("Allow openrouter"));
    const save = screen.getByRole("button", { name: "Save policy" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(calls.some((call) => call.method === "PUT")).toBe(true)
    );
    const put = calls.find((call) => call.method === "PUT");
    expect(put).toMatchObject({
      url: "/api/orgs/org-1/provider-policy",
      body: {
        allowed_providers: ["bedrock", "openai"],
        require_zdr: true,
        require_no_training: false
      }
    });
    // The stored policy comes back; the panel is clean again and removable.
    expect(await screen.findByRole("button", { name: "Remove policy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
  });

  it("refuses an empty allowlist client-side", async () => {
    stubBackend(null);
    render(<ProviderPolicyPanel orgId="org-1" canManage />);
    fireEvent.click(await screen.findByLabelText("Allow all providers"));
    fireEvent.click(screen.getByLabelText("Allow bedrock"));
    fireEvent.click(screen.getByLabelText("Allow openai"));
    fireEvent.click(screen.getByLabelText("Allow openrouter"));
    expect(screen.getByRole("button", { name: "Save policy" })).toBeDisabled();
    expect(
      screen.getByText(/An empty allowlist would refuse every request/)
    ).toBeInTheDocument();
  });

  it("removes an existing policy behind the confirm dialog", async () => {
    const { calls } = stubBackend(POLICY);
    render(<ProviderPolicyPanel orgId="org-1" canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove policy" }));
    expect(await screen.findByText(/lifts every data-control restriction/)).toBeInTheDocument();
    // Two buttons now carry the label: the panel trigger and the dialog
    // confirm; the dialog's renders last.
    const dialogConfirm = screen
      .getAllByRole("button", { name: "Remove policy" })
      .at(-1) as HTMLElement;
    fireEvent.click(dialogConfirm);
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === "DELETE" && call.url === "/api/orgs/org-1/provider-policy"
        )
      ).toBe(true)
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove policy" })).not.toBeInTheDocument()
    );
  });

  it("renders read-only for members", async () => {
    stubBackend(POLICY);
    render(<ProviderPolicyPanel orgId="org-1" canManage={false} />);
    expect(await screen.findByText("bedrock")).toBeInTheDocument();
    expect(screen.getByLabelText("Require no-training providers")).toBeChecked();
    expect(screen.getByLabelText("Require no-training providers")).toBeDisabled();
    expect(screen.getByLabelText("Allow bedrock")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save policy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove policy" })).not.toBeInTheDocument();
    expect(screen.getByText("Only an organization admin can change this policy.")).toBeInTheDocument();
  });
});
