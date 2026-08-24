import { fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/models/opus-5",
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { WaterfallEditor } from "@/components/models-catalog/detail/waterfall-editor";
import { makeDeployment, makeRung } from "./models-catalog-fixtures";

// WaterfallEditor calls useLoginModal, so every test mounts it under the
// provider the workspace layout supplies; `isAuthenticated` drives whether a
// gated edit runs or bounces to the login modal.
function render(ui: Parameters<typeof renderBare>[0], isAuthenticated = true) {
  return renderBare(<LoginModalProvider isAuthenticated={isAuthenticated}>{ui}</LoginModalProvider>);
}

const PROVIDERS = [
  makeDeployment({ id: "dep-anthropic", provider: "anthropic", provider_model_id: "opus-5" }),
  makeDeployment({ id: "dep-bedrock", provider: "bedrock", provider_model_id: "aws.opus-5" }),
  makeDeployment({ id: "dep-local", provider: "local", provider_model_id: "opus-5-local" })
];

const DEFAULT_CHAIN = [
  makeRung({
    id: "r-0",
    position: 0,
    model_provider_id: "dep-anthropic",
    provider: "anthropic",
    provider_model_id: "opus-5"
  }),
  makeRung({
    id: "r-1",
    position: 1,
    model_provider_id: "dep-bedrock",
    provider: "bedrock",
    provider_model_id: "aws.opus-5"
  })
];

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("waterfall editor", () => {
  it("signed out: the chain is visible and editing prompts login", () => {
    render(
      <WaterfallEditor
        defaultChain={DEFAULT_CHAIN}
        initialOverride={null}
        orgId={null}
        providers={PROVIDERS}
        slug="opus-5"
      />,
      false
    );
    const chain = screen.getByTestId("waterfall-chain");
    expect(chain.textContent).toContain("opus-5");
    expect(chain.textContent).toContain("aws.opus-5");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to customize" }));
    // Signed out, editing prompts login in place (the workspace login modal),
    // never the editor.
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("waterfall-editor")).toBeNull();
  });

  it("signed in: reorders and saves the org override via PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        override: [
          makeRung({ id: "o-0", position: 0, model_provider_id: "dep-bedrock", provider: "bedrock" })
        ]
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WaterfallEditor
        defaultChain={DEFAULT_CHAIN}
        initialOverride={null}
        orgId="org-1"
        providers={PROVIDERS}
        slug="opus-5"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    // Move Bedrock above Anthropic, then save.
    fireEvent.click(screen.getByRole("button", { name: "Move rung 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save override" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/models/opus-5/waterfall");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      model_provider_ids: ["dep-bedrock", "dep-anthropic"],
      org_id: "org-1"
    });
    // The saved override renders with its badge.
    await waitFor(() => expect(screen.getByText("org override")).toBeInTheDocument());
  });

  it("offers only routes not already in the chain and appends the pick", () => {
    render(
      <WaterfallEditor
        defaultChain={DEFAULT_CHAIN}
        initialOverride={null}
        orgId="org-1"
        providers={PROVIDERS}
        slug="opus-5"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    const select = screen.getByRole("combobox", { name: "Add a route to the chain" });
    const options = [...select.querySelectorAll("option")].map((option) => option.value);
    expect(options).toEqual(["", "dep-local"]);
    fireEvent.change(select, { target: { value: "dep-local" } });
    expect(screen.getByTestId("waterfall-editor").textContent).toContain("opus-5-local");
  });

  it("shows the backend's rejection verbatim", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "deployment dep-x not found on model 'opus-5'" })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WaterfallEditor
        defaultChain={DEFAULT_CHAIN}
        initialOverride={null}
        orgId="org-1"
        providers={PROVIDERS}
        slug="opus-5"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save override" }));
    await waitFor(() =>
      expect(screen.getByText("deployment dep-x not found on model 'opus-5'")).toBeInTheDocument()
    );
  });
});
