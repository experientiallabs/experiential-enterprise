import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelApiCard } from "@/components/models/model-api-card";
import { buttonClassName } from "@/components/ui/Button";

const ORG_ID = "00000000-0000-0000-0000-000000000001";

function renderCard(overrides: Partial<Parameters<typeof ModelApiCard>[0]> = {}) {
  return render(
    <ModelApiCard
      canManageKeys
      modelName="support-prod"
      orgId={ORG_ID}
      servingBaseUrl="https://api.example"
      {...overrides}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelApiCard", () => {
  it("puts the playground entry on the card's title row and links the docs", () => {
    renderCard();
    expect(screen.getByRole("heading", { name: "API" })).toBeInTheDocument();
    const playground = screen.getByRole("link", { name: /Open in playground/ });
    expect(playground).toHaveAttribute("href", "/playground?model=support-prod");
    // The shared PlaygroundLink affordance: same ink button + gamepad mark as
    // every other surface that opens a model in the playground.
    expect(playground.className).toBe(buttonClassName("primary", undefined, "sm"));
    expect(playground.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("link", { name: "API docs" })).toHaveAttribute("href", "/docs");
  });

  it("leads with the copyable endpoint URL, examples collapsed", () => {
    renderCard();
    const urlRow = screen.getByTestId("api-endpoint-url");
    expect(urlRow).toHaveTextContent("POST");
    // OpenAI-compatible: ONE shared completions URL, never a model-scoped
    // path (the product owner, 2026-07-30) - existing OpenAI apps change nothing.
    expect(urlRow).toHaveTextContent("https://api.example/v1/chat/completions");
    expect(screen.getByRole("button", { name: "Copy endpoint URL" })).toBeInTheDocument();
    // The model-specific half rides the request's model parameter, shown as
    // its own copyable row.
    const modelRow = screen.getByTestId("api-model-param");
    expect(modelRow).toHaveTextContent("model");
    expect(modelRow).toHaveTextContent("support-prod");
    expect(screen.getByRole("button", { name: "Copy model name" })).toBeInTheDocument();
    // No example is open until one is picked.
    expect(screen.queryByTestId("api-snippet")).not.toBeInTheDocument();
  });

  it("opens one example per pick, with a copy control, and closes on re-pick", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "HTTP" }));
    expect(screen.getByText(/POST \/v1\/chat\/completions HTTP\/1.1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy http snippet" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "cURL" }));
    expect(
      screen.getByText(/curl "https:\/\/api.example\/v1\/chat\/completions"/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/POST \/v1\/chat\/completions HTTP\/1.1/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Python" }));
    expect(screen.getByText(/from openai import OpenAI/)).toBeInTheDocument();

    // Picking the open example again collapses the card back to the URL row.
    fireEvent.click(screen.getByRole("button", { name: "Python" }));
    expect(screen.queryByTestId("api-snippet")).not.toBeInTheDocument();
  });

  it("mints an org key in place and shows the secret once", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ apiKey: { id: "key-1" }, secret: "sk-test-secret" })
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByTestId("api-key-minted")).toHaveTextContent("sk-test-secret");
    // The key is an ordinary org key, so the card points at where it now lives.
    expect(screen.getByRole("link", { name: "API keys" })).toHaveAttribute(
      "href",
      "/api-keys"
    );

    // The mint request is the same contract the Settings panel uses.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/keys",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body
    ) as { orgId: string; name: string };
    expect(body.orgId).toBe(ORG_ID);
    expect(body.name).toBe("support-prod key");
  });

  it("surfaces the mint refusal instead of pretending a key exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "Only organization admins can manage API keys." })
      }))
    );
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByTestId("api-key-mint-error")).toHaveTextContent(
      "Only organization admins can manage API keys."
    );
    expect(screen.queryByTestId("api-key-minted")).not.toBeInTheDocument();
  });

  it("offers no mint button to a viewer who cannot manage keys", () => {
    renderCard({ canManageKeys: false });
    expect(screen.queryByRole("button", { name: "Create API key" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "org API key" })).toHaveAttribute(
      "href",
      "/api-keys"
    );
  });
});
