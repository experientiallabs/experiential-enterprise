import { headers } from "next/headers";
import Link from "next/link";

import { AgentSetup } from "@/components/docs/AgentSetup";
import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeBlock } from "@/components/docs/CodeBlock";
import {
  Callout,
  Code,
  DocsList,
  DocsSection,
  DocsSteps,
  Prose,
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import { buildAgentPrompt } from "@/components/coding-agents/setup-prompt";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";
import { webBaseUrlFromHeaders } from "@/lib/public-web-url";

export const metadata = { title: "Coding agents" };

// Route coding agents through the gateway: each section is that agent's own
// configuration mechanism pointed at the /v1 surface, verified against the
// agent's official reference (Codex's committed config.schema.json,
// opencode.ai/docs, docs.cline.bot, code.claude.com/docs) — not community
// lore. Two protocol notes: current Codex speaks ONLY the Responses API
// (served, previous_response_id honored on any worker), and Claude Code
// speaks the Anthropic Messages API (served at /v1/messages as a translation
// lane over the chat surface).
export default async function CodingAgentsDocsPage() {
  const baseUrl = docsApiBaseUrl();
  const webBaseUrl = webBaseUrlFromHeaders(await headers()) ?? PLATFORM_WEB_URL;
  const promptFor = (agent: Parameters<typeof buildAgentPrompt>[0]) =>
    buildAgentPrompt(agent, webBaseUrl, baseUrl);
  return (
    <>
      <DocsPageHeader
        eyebrow="Guides"
        title="Coding agents"
        lede="Point Claude Code, Conductor, Codex, OpenCode, Cline, or any OpenAI-compatible agent at the gateway: one base URL, one key, every model in your catalog, and all usage in one place."
      />

      <DocsSection id="before-you-start" title="Before you start">
        <DocsSteps>
          <li>
            Mint a key in{" "}
            <Link
              className="text-ink underline underline-offset-2"
              href="/api-keys"
            >
              Settings, API keys
            </Link>{" "}
            and export it: <Code>export EXPLABS_API_KEY=xpl_...</Code>
          </li>
          <li>
            Pick a model slug. <Code>GET {baseUrl}/v1/models</Code> lists every
            slug your key can call; the snippets below use examples from the
            public catalog.
          </li>
        </DocsSteps>
        <Prose>
          Every agent below works the same way: its provider configuration gets
          the base URL <Code>{baseUrl}/v1</Code>, the key rides as{" "}
          <Code>Authorization: Bearer</Code>, and models are named by bare slug.
          Streaming is SSE on both Chat Completions and the Responses API.
        </Prose>
        <Callout>
          Every agent below opens on a{" "}
          <strong className="font-medium text-ink">Prompt</strong> tab: paste it
          into that agent and it wires itself up, verifies the key, and reports
          what it changed. Switch to{" "}
          <strong className="font-medium text-ink">Manual setup</strong> to do
          it by hand. One prompt that works in any of them lives at{" "}
          <Link
            className="text-ink underline underline-offset-2"
            href="/docs/setup-prompts#agent-integration"
          >
            Setup prompts
          </Link>
          .
        </Callout>
      </DocsSection>

      <DocsSection id="codex" title="OpenAI Codex CLI">
        <Prose>
          Codex configures custom gateways as a <Code>model_providers</Code>{" "}
          entry in <Code>~/.codex/config.toml</Code>. Current Codex releases
          speak only the Responses API (
          <Code>wire_api = &quot;responses&quot;</Code> is the sole supported
          value since early 2026), which the gateway serves at{" "}
          <Code>/v1/responses</Code>.
        </Prose>
        <AgentSetup prompt={promptFor("codex")}>
          <CodeBlock
            code={codexConfigToml(baseUrl)}
            language="toml"
            title="~/.codex/config.toml"
          />
          <Prose>
            Run Codex with <Code>EXPLABS_API_KEY</Code> exported. Leave{" "}
            <Code>requires_openai_auth</Code> unset: setting it forces a ChatGPT
            login instead of your gateway key.
          </Prose>
          <Callout>
            Codex continues turns with <Code>previous_response_id</Code>. The
            gateway honors continuation on any worker instance and retains
            continuations for 24 hours; an expired id returns{" "}
            <Code>400 continuation_unavailable</Code> and Codex resends the
            conversation.
          </Callout>
        </AgentSetup>
      </DocsSection>

      <DocsSection id="opencode" title="OpenCode">
        <Prose>
          OpenCode takes a custom provider in <Code>opencode.json</Code>{" "}
          (per-project at the repo root, or global at{" "}
          <Code>~/.config/opencode/opencode.json</Code>) using the{" "}
          <Code>@ai-sdk/openai-compatible</Code> package, which targets{" "}
          <Code>/v1/chat/completions</Code>.
        </Prose>
        <AgentSetup prompt={promptFor("opencode")}>
          <CodeBlock
            code={opencodeConfigJson(baseUrl)}
            language="json"
            title="opencode.json"
          />
          <Prose>
            Models you list here appear in the <Code>/models</Code> picker
            automatically. Set <Code>limit.context</Code> and{" "}
            <Code>limit.output</Code> from the catalog&apos;s values (
            <Code>GET {baseUrl}/api/models/&lt;slug&gt;</Code>), since OpenCode
            cannot infer them for a custom gateway.
          </Prose>
        </AgentSetup>
      </DocsSection>

      <DocsSection id="cline" title="Cline (VS Code)">
        <Prose>
          Cline is configured in the extension&apos;s settings UI, not a file.
        </Prose>
        <AgentSetup prompt={promptFor("cline")}>
          <DocsSteps>
            <li>
              Open Cline&apos;s settings and set{" "}
              <strong className="font-medium text-ink">API Provider</strong> to{" "}
              <Code>OpenAI Compatible</Code>.
            </li>
            <li>
              <strong className="font-medium text-ink">Base URL</strong>:{" "}
              <Code>{baseUrl}/v1</Code>
            </li>
            <li>
              <strong className="font-medium text-ink">API Key</strong>: your{" "}
              <Code>xpl_...</Code> key (no <Code>Bearer</Code> prefix).
            </li>
            <li>
              <strong className="font-medium text-ink">Model ID</strong>: a slug
              from <Code>/v1/models</Code>, e.g. <Code>claude-opus-5</Code>.
            </li>
            <li>
              Set the model&apos;s context window and max output tokens in
              Cline&apos;s per-model fields from the catalog&apos;s values;
              Cline cannot infer them for models it does not recognize.
            </li>
          </DocsSteps>
        </AgentSetup>
      </DocsSection>

      <DocsSection
        id="any-openai-tool"
        title="Any other OpenAI-compatible tool"
      >
        <Prose>
          Tools built on the official OpenAI SDKs (and most terminal agents,
          including Blackbox and Grok Build) honor the standard environment
          pair; nothing else changes:
        </Prose>
        <AgentSetup prompt={promptFor("openai-compatible")}>
          <CodeBlock
            code={envVarSnippet(baseUrl)}
            language="bash"
            title="shell"
          />
          <Prose>
            If a tool asks for the values in its own config instead, it needs
            the same three: base URL <Code>{baseUrl}/v1</Code>, the key, and a
            model slug.
          </Prose>
        </AgentSetup>
      </DocsSection>

      <DocsSection id="claude-code" title="Claude Code">
        <Prose>
          The gateway serves the Anthropic Messages API at{" "}
          <Code>/v1/messages</Code>, so Claude Code connects like any LLM
          gateway: point <Code>ANTHROPIC_BASE_URL</Code> at it (no{" "}
          <Code>/v1</Code> suffix; Claude Code appends the path) and pass your
          key as <Code>ANTHROPIC_AUTH_TOKEN</Code>. Any catalog slug works as
          the model, not just Claude models.
        </Prose>
        <AgentSetup prompt={promptFor("claude-code")}>
          <CodeBlock
            code={claudeCodeSnippet(baseUrl)}
            language="bash"
            title="shell"
          />
          <Callout>
            The Messages lane is a translation onto the gateway&apos;s chat
            surface, with three visible limits: extended thinking is not
            available (thinking blocks are accepted and dropped), image and
            document blocks are rejected because the chat surface is text-only,
            and <Code>/v1/messages/count_tokens</Code> answers an explicit{" "}
            <Code>404 not_found_error</Code> (Claude Code estimates locally).
          </Callout>
        </AgentSetup>
      </DocsSection>

      <DocsSection id="conductor" title="Conductor">
        <Prose>
          Conductor (the Mac app that runs parallel Claude Code agents in git
          worktrees) delegates provider configuration to Claude Code&apos;s
          environment contract, so it uses the same three variables. Set them in{" "}
          <strong className="font-medium text-ink">
            Settings, Environment
          </strong>{" "}
          under the Claude Code section:
        </Prose>
        <AgentSetup prompt={promptFor("conductor")}>
          <CodeBlock
            code={conductorEnvSnippet(baseUrl)}
            language="bash"
            title="Conductor → Settings → Environment"
          />
          <Prose>
            <Code>ANTHROPIC_API_KEY</Code> must be present and <em>empty</em>:
            it stops Claude Code from trying to authenticate with Anthropic
            directly. To scope the gateway to one repository instead, put the
            same variables in <Code>.conductor/settings.local.toml</Code>{" "}
            (machine-local, so the key stays out of the shared config):
          </Prose>
          <CodeBlock
            code={conductorTomlSnippet(baseUrl)}
            language="toml"
            title=".conductor/settings.local.toml"
          />
          <Callout>
            Conductor&apos;s per-chat model picker lists stock Claude aliases;
            to route a picker alias to a different catalog slug, remap it with{" "}
            <Code>ANTHROPIC_MODEL</Code> or the{" "}
            <Code>ANTHROPIC_DEFAULT_*_MODEL</Code> variables in the same
            environment block. The Claude Code lane limits above apply
            unchanged.
          </Callout>
        </AgentSetup>
      </DocsSection>

      <DocsSection id="usage" title="Watch what your agents spend">
        <Prose>
          Every call an agent makes lands in the same usage stream as the rest
          of your traffic. Humans read it at{" "}
          <Link
            className="text-ink underline underline-offset-2"
            href="/logs"
          >
            Logs
          </Link>{" "}
          and{" "}
          <Link
            className="text-ink underline underline-offset-2"
            href="/credits"
          >
            Credits
          </Link>
          ; agents read their own via{" "}
          <Code>GET {baseUrl}/api/gateway/usage/daily</Code>. Mint one key per
          agent to see spend broken out per tool.
        </Prose>
        <DocsList>
          <li>
            Error handling is uniform across agents: see{" "}
            <Link
              className="text-ink underline underline-offset-2"
              href="/docs/errors"
            >
              Errors
            </Link>{" "}
            for the stable codes and the retry playbook.
          </li>
          <li>
            Which models an agent can reach, and how each is paid for, is the
            catalog and lanes story in{" "}
            <Link
              className="text-ink underline underline-offset-2"
              href="/docs/models"
            >
              Models
            </Link>
            .
          </li>
        </DocsList>
      </DocsSection>
    </>
  );
}

// Config snippets interpolate the one base-URL module, like every other docs
// snippet, so a domain change is a deploy/env change, never a docs edit.

function codexConfigToml(baseUrl: string): string {
  return [
    'model = "gpt-5.5"',
    'model_provider = "explabs"',
    "",
    "[model_providers.explabs]",
    'name = "Experiential Labs"',
    `base_url = "${baseUrl}/v1"`,
    'env_key = "EXPLABS_API_KEY"',
    'wire_api = "responses"',
  ].join("\n");
}

function opencodeConfigJson(baseUrl: string): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "explabs/claude-opus-5",
      provider: {
        explabs: {
          npm: "@ai-sdk/openai-compatible",
          name: "Experiential Labs",
          options: {
            baseURL: `${baseUrl}/v1`,
            apiKey: "{env:EXPLABS_API_KEY}",
          },
          models: {
            "claude-opus-5": {
              name: "Claude Opus 5",
              limit: { context: 200000, output: 64000 },
            },
          },
        },
      },
    },
    null,
    2,
  );
}

function claudeCodeSnippet(baseUrl: string): string {
  return [
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    'export ANTHROPIC_AUTH_TOKEN="xpl_..."',
    'export ANTHROPIC_MODEL="claude-opus-5"',
    "claude",
  ].join("\n");
}

function conductorEnvSnippet(baseUrl: string): string {
  return [
    `ANTHROPIC_BASE_URL=${baseUrl}`,
    "ANTHROPIC_AUTH_TOKEN=xpl_...",
    "ANTHROPIC_API_KEY=",
  ].join("\n");
}

function conductorTomlSnippet(baseUrl: string): string {
  return [
    "[environment_variables]",
    `ANTHROPIC_BASE_URL = "${baseUrl}"`,
    'ANTHROPIC_AUTH_TOKEN = "xpl_..."',
    'ANTHROPIC_API_KEY = ""',
  ].join("\n");
}

function envVarSnippet(baseUrl: string): string {
  return [
    `export OPENAI_BASE_URL="${baseUrl}/v1"`,
    'export OPENAI_API_KEY="xpl_..."',
  ].join("\n");
}
