import { describe, expect, it } from "vitest";

import {
  buildTraceTelemetryPrompt,
  TRACE_PULL_TRANSPORTS,
  TRACE_UPLOAD_FORMATS
} from "@/components/trace-onboarding/setup-prompt";

describe("buildTraceTelemetryPrompt", () => {
  const prompt = buildTraceTelemetryPrompt("https://web.example", "https://api.example");

  it("creates the account hands-off via instant signup, no device/browser flow", () => {
    // instant signup is a Next.js route on the WEB origin, not the FastAPI api
    // host (which serves /v1 and the device flow); posting it to api 401s.
    expect(prompt).toContain("POST https://web.example/api/signup/instant");
    expect(prompt).not.toContain("POST https://api.example/api/signup/instant");
    expect(prompt).toContain('base_url = "https://api.example/v1"');
    // The frictionless path replaces the device-code browser flow entirely.
    expect(prompt).not.toContain("/api/signup/device/start");
    expect(prompt).not.toContain("/api/signup/device/poll");
    expect(prompt).not.toContain("428 authorization_pending");
  });

  it("asks the founder for their email and never invents or scavenges one", () => {
    expect(prompt).toContain("Ask me for my email address");
    expect(prompt).toContain("What's your email?");
    expect(prompt).toContain("Never invent or guess an address");
    // The old auto-discovery (git config / gh / npm) is gone: the agent asks.
    expect(prompt).not.toContain("git config user.email");
    expect(prompt).not.toContain("gh api user --jq .email");
  });

  it("does not spend before verification, and closes on the one manual step", () => {
    // The prove step is a non-spending models read, not a paid completion.
    expect(prompt).toContain("GET https://api.example/v1/models");
    expect(prompt).toContain("does NOT spend credits");
    // The single remaining human action: verify the email to unlock credits.
    expect(prompt).toContain("click the verification link");
    expect(prompt).toContain("https://web.example/signin");
    expect(prompt).toContain("insufficient_quota");
  });

  it("is provider-agnostic: it interviews before branching", () => {
    expect(prompt).toContain("Interview me: where do my LLM traces live?");
    // Neither branch is taken without the interview answer.
    expect(prompt).toContain("Only follow the ONE\n   path that matches my answer.");
  });

  it("pulls live from the org-scoped telemetry pull route", () => {
    expect(prompt).toContain(
      "POST https://api.example/api/orgs/<org_id>/telemetry/traces/pull"
    );
    expect(prompt).toContain('"transport_kind"');
    expect(prompt).toContain("Authorization: Bearer $EXPLABS_API_KEY");
  });

  it("uploads a file through the signed Storage URL then finalize", () => {
    expect(prompt).toContain(
      "POST https://api.example/api/orgs/<org_id>/telemetry/traces/upload"
    );
    expect(prompt).toContain(
      "POST https://api.example/api/orgs/<org_id>/telemetry/traces/<ingest_id>/finalize"
    );
    expect(prompt).toContain("source_kind");
    expect(prompt).toContain("source_label");
    expect(prompt).toContain("signed_url");
    expect(prompt).toContain("--data-binary @<path to my trace file>");
    expect(prompt).not.toContain("-F file=@<path to my trace file>");
  });

  it("verifies the landed count via the telemetry read route", () => {
    expect(prompt).toContain("GET https://api.example/api/orgs/<org_id>/telemetry/traces");
    expect(prompt).toContain("total_traces");
  });

  it("names every pull transport and upload format the backend admits", () => {
    for (const transport of TRACE_PULL_TRANSPORTS) {
      expect(prompt).toContain(transport);
    }
    for (const format of TRACE_UPLOAD_FORMATS) {
      expect(prompt).toContain(format);
    }
  });

  it("routes Arize and Phoenix to the file-upload path (no live pull yet)", () => {
    expect(prompt).toContain("If I'm on Arize or Phoenix, there's no live pull yet");
    expect(prompt).toContain('source_kind "phoenix"');
  });

  it("carries zero product context: never mentions a router, Project, preparation, or optimize", () => {
    // The prompt is written for someone with no knowledge of the product's
    // routers or Projects; those concepts must not leak into the paste text.
    // Lowercase "project" remains valid in provider configuration (e.g.
    // Braintrust's {"project": ...}) and ordinary language such as "the current
    // project"; only product-specific names and endpoint paths are prohibited.
    expect(prompt).not.toContain("router");
    expect(prompt).not.toContain("Router");
    expect(prompt).not.toContain("Project");
    expect(prompt).not.toContain("/preparations");
    expect(prompt).not.toContain("/preparation");
    expect(prompt).not.toContain("Optimize");
    expect(prompt).not.toContain("optimize");
    expect(prompt).not.toContain("/projects");
  });

  it("points the human at the telemetry dashboard", () => {
    expect(prompt).toContain("${web}/telemetry".replace("${web}", "https://web.example"));
  });
});
