import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  chatCompletionsSnippets,
  EndpointCard,
  PLATFORM_SERVING_BASE_URL,
  resolveServingBaseUrl,
  Snippet
} from "@/components/world-models/endpoint-snippets";

describe("resolveServingBaseUrl", () => {
  // The local-vs-platform switch (the product owner, 2026-07-30): hosted by default,
  // overridden only when a deployment configures its own public URL.
  it("falls back to the hosted platform when unset or empty", () => {
    expect(resolveServingBaseUrl(undefined)).toBe(PLATFORM_SERVING_BASE_URL);
    expect(resolveServingBaseUrl("")).toBe(PLATFORM_SERVING_BASE_URL);
    expect(PLATFORM_SERVING_BASE_URL).toBe("https://api.experientiallabs.ai");
  });

  it("strips a trailing slash and whitespace, passes a clean URL through", () => {
    expect(resolveServingBaseUrl("https://api.example.com/")).toBe("https://api.example.com");
    expect(resolveServingBaseUrl("https://api.example.com")).toBe("https://api.example.com");
    expect(resolveServingBaseUrl(" http://127.0.0.1:18080 ")).toBe("http://127.0.0.1:18080");
  });
});

describe("EndpointCard and Snippet", () => {
  it("render the title kicker and the mono snippet body", () => {
    render(
      <EndpointCard title="Chat Completions">
        <Snippet text={"curl -X POST"} />
      </EndpointCard>
    );
    expect(screen.getByText("Chat Completions")).toBeInTheDocument();
    expect(screen.getByText("curl -X POST")).toBeInTheDocument();
  });
});

describe("chatCompletionsSnippets", () => {
  it("builds the base_url-swap pair with runnable auth on both", () => {
    const snippets = chatCompletionsSnippets("support-prod", "https://x");
    expect(snippets.curl).toContain('"https://x/v1/chat/completions"');
    expect(snippets.curl).toContain('"model": "support-prod"');
    expect(snippets.curl).toContain("Bearer $EXPLABS_API_KEY");
    // A bare EXPLABS_API_KEY identifier would be a Python NameError.
    expect(snippets.python).toContain("import os");
    expect(snippets.python).toContain('api_key=os.environ["EXPLABS_API_KEY"]');
    expect(snippets.python).toContain('base_url="https://x/v1"');
  });
});
