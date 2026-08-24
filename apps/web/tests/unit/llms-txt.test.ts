import { describe, expect, it } from "vitest";

import { buildLlmsTxt } from "@/lib/llms-txt";

describe("llms.txt", () => {
  const hosted = buildLlmsTxt({ apiBaseUrl: "https://api.experientiallabs.ai" });
  const selfHosted = buildLlmsTxt({
    apiBaseUrl: "https://api.acme.internal",
    webBaseUrl: "https://platform.acme.internal"
  });

  it("documents the hosted platform by default and a self-host by its own URL", () => {
    expect(hosted).toContain("API base URL: https://api.experientiallabs.ai");
    expect(hosted).toContain("This is the hosted platform.");
    expect(selfHosted).toContain("API base URL: https://api.acme.internal");
    expect(selfHosted).toContain("This is a self-hosted or local deployment.");
    expect(selfHosted).toContain("https://api.experientiallabs.ai");
  });

  it("states the exact auth contract and the widened key scope", () => {
    expect(hosted).toContain("Authorization: Bearer <key>");
    expect(hosted).toContain("xpl_ + 40 lowercase hex chars");
    expect(hosted).toContain("reaches BOTH the inference surface");
    expect(hosted).toContain("CANNOT mint or revoke");
    expect(hosted).toContain("GET https://api.experientiallabs.ai/v1/models");
  });

  it("documents the OpenAI-compatible gateway surface including Responses", () => {
    expect(hosted).toContain("OpenAI-compatible model gateway");
    expect(hosted).toContain("POST https://api.experientiallabs.ai/v1/chat/completions");
    expect(hosted).toContain("POST https://api.experientiallabs.ai/v1/responses");
    expect(hosted).toContain('"model" MUST be a slug');
    // Responses continuation and idempotency are honored, not rejected — and
    // continuation is cross-worker (int-P2's shared Postgres store), so the
    // launch-era "same worker only" caveat must never come back.
    expect(hosted).toContain("previous_response_id");
    expect(hosted).toContain("continues a prior response on any worker instance");
    expect(hosted).not.toContain("ONLY on the worker instance that produced it");
    expect(hosted).toContain("Idempotency-Key is honored");
  });

  it("routes coding agents at the gateway, Claude Code included", () => {
    expect(hosted).toContain("## Coding agents");
    expect(hosted).toContain('OPENAI_BASE_URL="https://api.experientiallabs.ai/v1"');
    expect(hosted).toContain("/docs/coding-agents");
    // Claude Code connects through the Messages lane; the base URL has no /v1
    // suffix because Claude Code appends the path itself.
    expect(hosted).toContain('ANTHROPIC_BASE_URL="https://api.experientiallabs.ai"');
    expect(hosted).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(hosted).not.toContain("Claude Code is NOT supported");
    // Conductor rides the same env contract, with the empty-ANTHROPIC_API_KEY
    // guard stated explicitly.
    expect(hosted).toContain("Conductor");
    expect(hosted).toContain(".conductor/settings.local.toml");
    expect(hosted).toContain("ANTHROPIC_API_KEY to the EMPTY string");
  });

  it("documents the Anthropic Messages lane with its exact limits", () => {
    expect(hosted).toContain("POST https://api.experientiallabs.ai/v1/messages");
    expect(hosted).toContain("Anthropic Messages API, translated onto the same chat surface");
    const flat = hosted.replace(/\s+/g, " ");
    // The limits are the contract: no thinking, text-only, no idempotency,
    // no count_tokens, Anthropic-enveloped errors.
    expect(flat).toContain("thinking config and blocks are accepted and dropped");
    expect(flat).toContain("image/document blocks -> 400");
    expect(flat).toContain("Idempotency-Key is not honored here");
    expect(flat).toContain("/v1/messages/count_tokens answers an explicit 404 not_found_error");
    expect(flat).toContain('{"type":"error","error":{"type","message"}}');
  });

  it("documents the public catalog, waterfalls, and the two payment lanes", () => {
    expect(hosted).toContain("public\nmodel catalog");
    expect(hosted).toContain("provider waterfall");
    expect(hosted).toContain("pass_through");
    expect(hosted).toContain("platform_funded");
    expect(hosted).toContain("No markup");
    for (const provider of [
      "openai",
      "anthropic",
      "gemini",
      "azure_openai",
      "openrouter",
      "bedrock",
      "local",
      "fireworks",
      "modal",
      "experiential_cloud"
    ]) {
      expect(hosted).toContain(provider);
    }
    expect(hosted).toContain(
      "Experiential Cloud is a curated collection of models, hosted and optimized by"
    );
    expect(hosted).not.toContain("native vLLM");
    expect(hosted).not.toContain("platform-operated");
    expect(hosted).not.toContain("serving lane");
  });

  it("gives agents the stable /v1 error codes and a recovery playbook", () => {
    for (const code of [
      "invalid_key",
      "model_not_granted",
      "unsupported_capability",
      "continuation_unavailable",
      "idempotency_conflict",
      "insufficient_quota",
      "all_routes_failed",
      "deadline_exceeded"
    ]) {
      expect(hosted).toContain(code);
    }
    expect(hosted).toContain("Retry 429 (throttled)/502/503/504 with backoff");
    expect(hosted).toContain("at-least-once");
  });

  it("lists the management API an agent drives with the same key", () => {
    expect(hosted).toContain("/api/models/<slug>/waterfall");
    expect(hosted).toContain("/api/orgs/<org_id>/provider-connections/<provider>");
    expect(hosted).toContain("/api/gateway/usage/daily");
    expect(hosted).toContain("/api/keys");
  });

  it("documents the catalog contract: /api browse keyless, /v1/models keyed, writes keyed", () => {
    // The shipped split (fix-catalog-keyless): GET /api/models* is public and
    // keyless (anonymous -> public rows only), GET /v1/models keeps the
    // OpenAI-compat key requirement, and every write stays keyed. Guards the
    // S4 accuracy bug from returning in either direction.
    const flat = hosted.replace(/\s+/g, " ");
    expect(flat).toContain("public, keyless read: GET https://api.experientiallabs.ai/api/models");
    expect(flat).toContain(
      "https://api.experientiallabs.ai/v1/models (the OpenAI-compatible list) requires your key"
    );
    // Writes are never described as keyless: they act for the key's own org.
    expect(flat).toContain("the key acts for its own org");
  });

  it("omits every retired Project-era surface", () => {
    // NB: /api/whoami is intentionally NOT in this list — it is a live
    // customer-key route surfaced by the shared onboarding setup prompts below,
    // not a retired Project-era surface.
    for (const retired of [
      "Responses API is not exposed",
      "no public model catalog",
      "provider-free preparation",
      "attach traces",
      "simulation",
      "Simulation",
      "GEPA"
    ]) {
      expect(hosted).not.toContain(retired);
    }
  });

  it("carries the copy-paste setup prompts from the shared registry", () => {
    // The same prompts the /docs page and the in-app onboarding render, so all
    // three surfaces stay one source of truth (lib/setup-prompts.ts).
    expect(hosted).toContain("## Setup prompts");
    expect(hosted).toContain("### Create an account from your coding agent");
    expect(hosted).toContain("### Set up the gateway in an existing project");
    expect(hosted).toContain("### Bring your traces in as telemetry");
    // The prod URLs must be interpolated into the prompt bodies.
    expect(hosted).toContain("https://api.experientiallabs.ai/v1");
    // A self-hosted build documents its own URLs in the prompts too.
    expect(selfHosted).toContain("### Create an account from your coding agent");
    expect(selfHosted).toContain("https://api.acme.internal/v1");
  });
});
