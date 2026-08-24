import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() })
}));

import {
  ExperientialCloudBrowse,
  type ExperientialCloudModelOption
} from "@/components/admin/ExperientialCloudBrowse";
import type { ExperientialCloudDeployment } from "@/lib/experiential-cloud/types";
import type { CatalogDeployment } from "@/lib/models-catalog/types";

const EC_ID = "11111111-1111-1111-1111-111111111111";

const MODELS: ExperientialCloudModelOption[] = [
  { slug: "deepseek-v4-flash", display_name: "DeepSeek V4 Flash" },
  { slug: "qwen3.8-27b", display_name: "Qwen3.8 27B" }
];

function ecDeployment(overrides: Partial<CatalogDeployment> = {}): ExperientialCloudDeployment {
  const deployment: CatalogDeployment = {
    id: EC_ID,
    model_id: "model-deepseek",
    provider: "experiential_cloud",
    provider_model_id: "deepseek-v4-flash",
    base_url: null,
    region: null,
    api_version: null,
    owning_org_id: null,
    provider_connection_id: null,
    billing_source: "host_managed",
    input_micro_usd_per_million: 42448,
    cached_input_micro_usd_per_million: 8489,
    output_micro_usd_per_million: 84896,
    reasoning_micro_usd_per_million: null,
    pricing_source: null,
    pricing_effective_at: null,
    capabilities: {},
    uptime_30d: null,
    throughput_tps: null,
    latency_p50_ms: null,
    stats_source: null,
    status: "disabled",
    created_at: "2026-08-22T00:00:00+00:00",
    updated_at: "2026-08-22T00:00:00+00:00",
    ...overrides
  };
  return { slug: "deepseek-v4-flash", display_name: "DeepSeek V4 Flash", deployment };
}

function lastFetchCall(): [string, { method?: string; body?: string }] {
  const calls = vi.mocked(fetch).mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, { method?: string; body?: string }];
  return [url, init];
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
  cleanup();
});

describe("ExperientialCloudBrowse", () => {
  it("shows the off-until-wired empty state when no lanes exist", () => {
    render(
      <ExperientialCloudBrowse deployments={[]} models={MODELS} workerBaseUrlConfigured={false} />
    );
    expect(screen.getByText(/Experiential Cloud is off until you wire it/)).toBeInTheDocument();
  });

  it("keeps the attach button disabled until a model and wire id are set", () => {
    render(
      <ExperientialCloudBrowse deployments={[]} models={MODELS} workerBaseUrlConfigured={false} />
    );
    const submit = screen.getByRole("button", { name: /Attach Experiential Cloud/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "deepseek-v4-flash" } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Provider model id"), {
      target: { value: "deepseek-v4-flash" }
    });
    expect(submit).toBeEnabled();
  });

  it("attaches a lane staged OFF by default (no status in the payload)", async () => {
    render(
      <ExperientialCloudBrowse deployments={[]} models={MODELS} workerBaseUrlConfigured={false} />
    );
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "deepseek-v4-flash" } });
    fireEvent.change(screen.getByLabelText("Provider model id"), {
      target: { value: "deepseek-v4-flash" }
    });
    fireEvent.change(screen.getByLabelText("Endpoint (base_url)"), {
      target: { value: "https://vllm.internal:8000/v1" }
    });
    fireEvent.change(screen.getByLabelText("Input (µ$/M)"), { target: { value: "42448" } });
    fireEvent.click(screen.getByRole("button", { name: /Attach Experiential Cloud/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = lastFetchCall();
    expect(url).toBe("/api/admin/experiential-cloud");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body ?? "{}");
    expect(body).toMatchObject({
      slug: "deepseek-v4-flash",
      provider_model_id: "deepseek-v4-flash",
      base_url: "https://vllm.internal:8000/v1",
      input_micro_usd_per_million: 42448
    });
    expect(body.status).toBeUndefined();
  });

  it("sends status active only when 'serve immediately' is chosen", async () => {
    render(
      <ExperientialCloudBrowse deployments={[]} models={MODELS} workerBaseUrlConfigured={false} />
    );
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen3.8-27b" } });
    fireEvent.change(screen.getByLabelText("Provider model id"), {
      target: { value: "qwen3.8-27b" }
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Serve immediately/ }));
    fireEvent.click(screen.getByRole("button", { name: /Attach Experiential Cloud/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = lastFetchCall();
    expect(JSON.parse(init.body ?? "{}").status).toBe("active");
  });

  it("warns when a lane is ON with no endpoint and no worker origin", () => {
    render(
      <ExperientialCloudBrowse
        deployments={[ecDeployment({ status: "active", base_url: null })]}
        models={MODELS}
        workerBaseUrlConfigured={false}
      />
    );
    expect(screen.getByText(/is ON but has no endpoint/)).toBeInTheDocument();
  });

  it("does not warn when ON with a per-row endpoint", () => {
    render(
      <ExperientialCloudBrowse
        deployments={[ecDeployment({ status: "active", base_url: "https://vllm:8000/v1" })]}
        models={MODELS}
        workerBaseUrlConfigured={false}
      />
    );
    expect(screen.queryByText(/is ON but has no endpoint/)).not.toBeInTheDocument();
  });

  it("saves a row's hookup info via PATCH keyed on the id", async () => {
    render(
      <ExperientialCloudBrowse
        deployments={[ecDeployment()]}
        models={MODELS}
        workerBaseUrlConfigured={false}
      />
    );
    // Two "Endpoint (base_url)" fields exist (attach form + the row); [1] is the row.
    fireEvent.change(screen.getAllByLabelText("Endpoint (base_url)")[1], {
      target: { value: "https://vllm-2:8000/v1" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = lastFetchCall();
    expect(url).toBe(`/api/admin/experiential-cloud/${EC_ID}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body ?? "{}")).toMatchObject({
      provider_model_id: "deepseek-v4-flash",
      base_url: "https://vllm-2:8000/v1"
    });
  });

  it("preserves the hidden reasoning-token rate on a hookup save", async () => {
    render(
      <ExperientialCloudBrowse
        deployments={[ecDeployment({ reasoning_micro_usd_per_million: 12345 })]}
        models={MODELS}
        workerBaseUrlConfigured={false}
      />
    );
    // Edit only the endpoint; the form never exposes the reasoning rate.
    fireEvent.change(screen.getAllByLabelText("Endpoint (base_url)")[1], {
      target: { value: "https://vllm-3:8000/v1" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = lastFetchCall();
    // The full-resource PATCH must carry the existing rate, not null it out.
    expect(JSON.parse(init.body ?? "{}").reasoning_micro_usd_per_million).toBe(12345);
  });

  it("turns a lane ON only after confirming, posting status active", async () => {
    render(
      <ExperientialCloudBrowse
        deployments={[ecDeployment()]}
        models={MODELS}
        workerBaseUrlConfigured={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn ON" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn ON" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = lastFetchCall();
    expect(url).toBe(`/api/admin/experiential-cloud/${EC_ID}/status`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ status: "active" });
  });

  it("turns a lane OFF immediately without a confirm", async () => {
    render(
      <ExperientialCloudBrowse
        deployments={[ecDeployment({ status: "active", base_url: "https://vllm:8000/v1" })]}
        models={MODELS}
        workerBaseUrlConfigured={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn OFF" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = lastFetchCall();
    expect(url).toBe(`/api/admin/experiential-cloud/${EC_ID}/status`);
    expect(JSON.parse(init.body ?? "{}")).toEqual({ status: "disabled" });
  });
});
