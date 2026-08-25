import { fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/models/new",
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import {
  CustomModelForm,
  microFromUsdText,
  slugFromName,
  slugProblem
} from "@/components/models-catalog/custom-model-form";

// CustomModelForm gates through useLoginModal; mount the login-modal host. The
// signed-out arrival case passes isAuthenticated={false}.
function render(ui: Parameters<typeof renderBare>[0], isAuthenticated = true) {
  return renderBare(<LoginModalProvider isAuthenticated={isAuthenticated}>{ui}</LoginModalProvider>);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("slug derivation and validation", () => {
  it("derives a gateway-safe slug from the display name", () => {
    expect(slugFromName("My Fine-Tuned Coder!")).toBe("my-fine-tuned-coder");
    expect(slugFromName("  7B qwen  ")).toBe("b-qwen");
    expect(slugFromName("GPT 5.6 (internal)")).toBe("gpt-5.6-internal");
  });

  it("rejects malformed and route-shadowing slugs", () => {
    expect(slugProblem("my-model")).toBeNull();
    expect(slugProblem("9starts-with-digit")).not.toBeNull();
    expect(slugProblem("Has-Upper")).not.toBeNull();
    // Static siblings of /models/[modelSlug] and reserved root segments would
    // make the model unreachable behind its own detail route.
    expect(slugProblem("new")).not.toBeNull();
    expect(slugProblem("compare")).not.toBeNull();
    expect(slugProblem("telemetry")).not.toBeNull();
  });

  it("converts optional $/M text to integer micro-USD, blank meaning unpriced", () => {
    expect(microFromUsdText("0.50")).toBe(500_000);
    expect(microFromUsdText("  ")).toBeNull();
    expect(microFromUsdText("-1")).toBeUndefined();
    expect(microFromUsdText("abc")).toBeUndefined();
  });
});

describe("custom model form", () => {
  it("prompts login on arrival when signed out (frame still renders)", () => {
    // Signed out, the form frame still renders and a login prompt fires in
    // place (the workspace login modal).
    render(<CustomModelForm orgId={null} />, false);
    expect(screen.getByTestId("custom-model-form")).toBeInTheDocument();
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
  });

  it("POSTs the typed payload and lands on the created detail page", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ model: { slug: "my-coder" } })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CustomModelForm orgId="org-1" />);
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "My Coder" } });
    fireEvent.change(screen.getByLabelText(/Base URL/), {
      target: { value: "https://gpu.example.com:8000/v1" }
    });
    fireEvent.change(screen.getByLabelText(/Input \$ \/ M tokens/), {
      target: { value: "0.50" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create model" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/models");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      display_name: "My Coder",
      org_id: "org-1",
      slug: "my-coder",
      input_modalities: ["text"],
      providers: [
        {
          provider: "local",
          base_url: "https://gpu.example.com:8000/v1",
          provider_model_id: "my-coder",
          input_micro_usd_per_million: 500_000,
          pricing_source: "self-reported"
        }
      ]
    });
    // Success lands on the new detail page with the call-it-now framing.
    await waitFor(() => expect(push).toHaveBeenCalledWith("/models/my-coder?created=1"));
  });

  it("omits pricing_source on an unpriced local model (blank means unknown, never $0)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ model: { slug: "my-coder" } })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CustomModelForm orgId="org-1" />);
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "My Coder" } });
    fireEvent.change(screen.getByLabelText(/Base URL/), {
      target: { value: "https://gpu.example.com:8000/v1" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create model" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const route = body.providers[0];
    expect(route.provider).toBe("local");
    // The API's DeploymentCreate is extra="forbid" with optional prices; an
    // unpriced local route must arrive without prices or a pricing_source.
    expect("pricing_source" in route).toBe(false);
    expect("input_micro_usd_per_million" in route).toBe(false);
    expect("output_micro_usd_per_million" in route).toBe(false);
  });

  it("shows the backend's message verbatim on rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "model 'my-coder' already exists in your organization" })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CustomModelForm orgId="org-1" />);
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "My Coder" } });
    fireEvent.change(screen.getByLabelText(/Base URL/), {
      target: { value: "https://gpu.example.com:8000/v1" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create model" }));

    await waitFor(() =>
      expect(
        screen.getByText("model 'my-coder' already exists in your organization")
      ).toBeInTheDocument()
    );
    expect(push).not.toHaveBeenCalled();
  });
});
