import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SetupPromptsDocsPage from "@/app/docs/setup-prompts/page";

// The page derives the web origin from the request, so pasted prompts never mix
// a self-hosted API with the hosted web host. Mock the forwarded host.
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-forwarded-host": "platform.experientiallabs.ai",
      "x-forwarded-proto": "https"
    })
}));

// The setup-prompts guide renders the shared registry (lib/setup-prompts.ts):
// one copyable CodeBlock per prompt, base URLs interpolated. These assertions
// pin the rendering contract, not the prompt prose.
describe("docs setup prompts page", () => {
  it("renders the title and one copyable block per registered prompt", async () => {
    render(await SetupPromptsDocsPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Setup prompts");
    // Four prompts in the registry -> four CodeBlock copy affordances.
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(4);
    for (const title of [
      "Create an account from your coding agent",
      "Set up the gateway in an existing project",
      "Bring your traces in as telemetry"
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    }
  });

  it("interpolates the request web origin and the resolved API origin", async () => {
    render(await SetupPromptsDocsPage());
    // API origin comes from the docs resolver (hosted default in tests); the
    // web origin comes from the forwarded host mocked above.
    expect(screen.getAllByText(/api\.experientiallabs\.ai\/v1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/platform\.experientiallabs\.ai/).length).toBeGreaterThan(0);
  });

  it("links the shareable setup-prompts repository", async () => {
    render(await SetupPromptsDocsPage());
    expect(screen.getByRole("link", { name: /setup-prompts repository/i })).toHaveAttribute(
      "href",
      "https://github.com/experientiallabs/setup-prompts"
    );
  });
});
