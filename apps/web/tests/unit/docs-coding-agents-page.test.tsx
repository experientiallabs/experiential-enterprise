import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CodingAgentsDocsPage from "@/app/docs/coding-agents/page";

// The page reads the web origin from the request so pasted prompts never mix a
// self-hosted API with the hosted web host.
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-forwarded-host": "platform.experientiallabs.ai",
      "x-forwarded-proto": "https"
    })
}));

// The coding-agents guide: every agent leads with its paste-able prompt, with
// the hand-configuration behind a second tab. These assertions pin the
// contract-bearing facts (which tab leads, the per-agent wire protocols and
// guards), not the prose.
async function renderPage() {
  render(await CodingAgentsDocsPage());
}

const AGENTS = ["Claude Code", "Conductor", "OpenAI Codex CLI", "OpenCode", "Cline (VS Code)"];

describe("docs coding agents page", () => {
  it("gives every agent a Prompt tab that leads, plus Manual setup", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Coding agents");
    for (const agent of AGENTS) {
      expect(screen.getByRole("heading", { level: 2, name: agent })).toBeInTheDocument();
    }
    // Five named agents plus the generic OpenAI-compatible fallback.
    const promptTabs = screen.getAllByRole("tab", { name: "Prompt" });
    const manualTabs = screen.getAllByRole("tab", { name: "Manual setup" });
    expect(promptTabs).toHaveLength(6);
    expect(manualTabs).toHaveLength(6);
    // Prompt is the tab a reader lands on, everywhere.
    for (const tab of promptTabs) {
      expect(tab).toHaveAttribute("aria-selected", "true");
    }
    for (const tab of manualTabs) {
      expect(tab).toHaveAttribute("aria-selected", "false");
    }
    // Only the prompt panels are reachable until a reader switches tabs, so
    // every visible copy affordance belongs to a prompt.
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(6);
  });

  it("switches one section to its manual config without disturbing the others", async () => {
    await renderPage();
    fireEvent.click(screen.getAllByRole("tab", { name: "Manual setup" })[0]);

    const selectedManual = screen
      .getAllByRole("tab", { name: "Manual setup" })
      .filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selectedManual).toHaveLength(1);
    // The other five sections still lead with their prompt.
    expect(
      screen
        .getAllByRole("tab", { name: "Prompt" })
        .filter((tab) => tab.getAttribute("aria-selected") === "true")
    ).toHaveLength(5);
  });

  it("carries each agent's own contract into its prompt", async () => {
    await renderPage();
    const prompts = screen
      .getAllByRole("button", { name: "Copy code" })
      .map((button) => button.closest("div")?.parentElement?.textContent ?? "");
    const all = prompts.join("\n");
    // Per-agent facts, each from that agent's prompt tab.
    expect(all).toContain('wire_api = "responses"');
    expect(all).toContain('ANTHROPIC_API_KEY = ""');
    expect(all).toContain("@ai-sdk/openai-compatible");
    expect(all).toContain("OpenAI Compatible");
    expect(all).toContain("OPENAI_BASE_URL");
    // The Anthropic base URL stays suffix-free; the OpenAI ones carry /v1.
    expect(all).toContain('ANTHROPIC_BASE_URL="https://api.experientiallabs.ai"');
    expect(all).toContain('base_url = "https://api.experientiallabs.ai/v1"');
    // Every prompt verifies the key before touching config.
    expect(all).toContain("GET https://api.experientiallabs.ai/v1/models");
  });

  it("keeps the manual configuration available behind the second tab", async () => {
    await renderPage();
    // Rendered but inert until selected; these are the hand-setup artifacts.
    expect(screen.getAllByText("~/.codex/config.toml").length).toBeGreaterThan(0);
    expect(screen.getAllByText("opencode.json").length).toBeGreaterThan(0);
    expect(screen.getAllByText(".conductor/settings.local.toml").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Model ID/).length).toBeGreaterThan(0);
  });

  it("states the Messages-lane limits and never the retired unsupported claim", async () => {
    await renderPage();
    expect(screen.queryByText(/not supported yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/extended thinking is not\s+available/)).toBeInTheDocument();
    expect(screen.getAllByText(/text-only/).length).toBeGreaterThan(0);
  });
});
