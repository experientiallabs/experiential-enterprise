import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() })
}));

import { PromotionsBrowse, type PromotionModelOption } from "@/components/admin/PromotionsBrowse";
import type { ModelPromotion } from "@/lib/promotions/types";

const PROMO_ID = "0c8f2c66-58f8-4c33-9e01-9a56f7e3f001";

const PROMOS: ModelPromotion[] = [
  {
    id: PROMO_ID,
    label: "Qwen launch",
    model_slugs: ["qwen3.8-27b"],
    family_keys: ["qwen"],
    providers: [],
    audience_labels: [],
    funding_scope: "platform_funded",
    per_org_cap_micro_usd: 10_000_000,
    discount_cap_micro_usd: 0,
    cap_scope: "lifetime",
    percent_off: 0,
    active: true,
    display_order: 0
  }
];

const MODELS: PromotionModelOption[] = [
  { slug: "qwen3.8-27b", display_name: "Qwen3.8 27B", familyKey: "qwen" },
  { slug: "qwen3.8-72b", display_name: "Qwen3.8 72B", familyKey: "qwen" },
  { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", familyKey: "openai" }
];

function lastFetchCall(): [string, { method?: string; body?: string }] {
  const calls = vi.mocked(fetch).mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, { method?: string; body?: string }];
  return [url, init];
}

function renderPanel(promotions: ModelPromotion[] = PROMOS) {
  return render(<PromotionsBrowse models={MODELS} promotions={promotions} />);
}

// The create form is folded behind the New promotion button.
function openCreateForm() {
  fireEvent.click(screen.getByRole("button", { name: /New promotion/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PromotionsBrowse", () => {
  it("renders a compact row: label, terms summary, and no editor until Edit", () => {
    renderPanel();
    expect(screen.getByText("Qwen launch")).toBeInTheDocument();
    expect(screen.getByText("$10 free · lifetime")).toBeInTheDocument();
    expect(screen.queryByLabelText("Label")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit Qwen launch" }));
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("Qwen launch");
    expect((screen.getByLabelText("Free cap (USD)") as HTMLInputElement).value).toBe("10");
    expect(screen.getByLabelText("Discount cap (USD)")).toBeInTheDocument();
  });

  it("marks an inactive promotion in the summary row", () => {
    renderPanel([{ ...PROMOS[0], active: false }]);
    expect(screen.getByText("inactive")).toBeInTheDocument();
  });

  it("keeps the create form folded until New promotion is clicked", () => {
    renderPanel([]);
    expect(screen.queryByLabelText("Label")).not.toBeInTheDocument();
    openCreateForm();
    expect(screen.getByLabelText("Label")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Label")).not.toBeInTheDocument();
  });

  it("cancel drops the draft so reopening starts clean", () => {
    renderPanel([]);
    openCreateForm();
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Half-typed promo" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Bedrock" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openCreateForm();
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("checkbox", { name: "Bedrock" })).not.toBeChecked();
  });

  it("expands a picked family to its catalog slugs as removable chips", () => {
    // No existing rows, so slug texts are unambiguous in the create form.
    renderPanel([]);
    openCreateForm();
    fireEvent.click(screen.getByRole("checkbox", { name: "Qwen" }));
    expect(screen.getByText("qwen3.8-27b")).toBeInTheDocument();
    expect(screen.getByText("qwen3.8-72b")).toBeInTheDocument();
    // Removing a chip excludes just that slug from the expansion.
    fireEvent.click(screen.getByRole("button", { name: "Remove qwen3.8-72b" }));
    expect(screen.queryByText("qwen3.8-72b")).not.toBeInTheDocument();
    expect(screen.getByText("qwen3.8-27b")).toBeInTheDocument();
  });

  it("rejects an unknown manual slug with an inline error and adds a known one", () => {
    renderPanel([]);
    openCreateForm();
    const input = screen.getByLabelText("Add a model by slug");
    fireEvent.change(input, { target: { value: "not-a-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText(/not a catalog model slug/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "gpt-5.6-luna" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByText(/not a catalog model slug/)).not.toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-luna")).toBeInTheDocument();
  });

  it("submits the v2 payload: union of expansion + manual adds, deduped and sorted", async () => {
    renderPanel();
    openCreateForm();
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Everything Qwen + Luna" }
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Qwen" }));
    const slugInput = screen.getByLabelText("Add a model by slug");
    fireEvent.change(slugInput, { target: { value: "gpt-5.6-luna" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // A duplicate manual add of an expanded slug must not double it.
    fireEvent.change(slugInput, { target: { value: "qwen3.8-27b" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Fireworks" }));
    fireEvent.change(screen.getByLabelText("Free cap (USD)"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Discount cap (USD)"), {
      target: { value: "5" }
    });
    fireEvent.change(screen.getByLabelText("% off"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /Add promotion/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = lastFetchCall();
    expect(url).toBe("/api/admin/model-promotions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({
      label: "Everything Qwen + Luna",
      model_slugs: ["gpt-5.6-luna", "qwen3.8-27b", "qwen3.8-72b"],
      family_keys: ["qwen"],
      providers: ["fireworks"],
      audience_labels: [],
      funding_scope: "platform_funded",
      per_org_cap_micro_usd: 20_000_000,
      discount_cap_micro_usd: 5_000_000,
      cap_scope: "lifetime",
      percent_off: 50,
      active: true,
      display_order: 0
    });
  });

  it("allows a provider-only scope and shows the applies-to-all help text", async () => {
    renderPanel();
    openCreateForm();
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Experiential Cloud half off" }
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Experiential Cloud" }));
    expect(
      screen.getByText(/Applies to all models served via the selected providers/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add promotion/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = lastFetchCall();
    expect(JSON.parse(init.body ?? "{}")).toMatchObject({
      model_slugs: [],
      providers: ["experiential_cloud"]
    });
  });

  it("keeps the submit disabled until a label and a scope exist", () => {
    renderPanel();
    openCreateForm();
    const submit = screen.getByRole("button", { name: /Add promotion/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Promo" } });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Bedrock" }));
    expect(submit).toBeEnabled();
  });

  it("saves an edited row via PUT keyed on the id with the full resource", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit Qwen launch" }));
    fireEvent.change(screen.getByLabelText("% off"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = lastFetchCall();
    expect(url).toBe(`/api/admin/model-promotions/${PROMO_ID}`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body ?? "{}")).toMatchObject({
      label: "Qwen launch",
      model_slugs: ["qwen3.8-27b"],
      family_keys: ["qwen"],
      providers: [],
      percent_off: 40
    });
  });

  it("removes a promotion via DELETE keyed on the id after confirmation", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Remove Qwen launch" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove promotion" })
    );

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = lastFetchCall();
    expect(url).toBe(`/api/admin/model-promotions/${PROMO_ID}`);
    expect(init.method).toBe("DELETE");
  });
});
