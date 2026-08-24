import { headers } from "next/headers";
import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { Callout, Code, DocsSection, Prose } from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";
import { webBaseUrlFromHeaders } from "@/lib/public-web-url";
import { buildSetupPrompts, SETUP_PROMPTS_REPO_URL } from "@/lib/setup-prompts";

export const metadata = { title: "Setup prompts" };

// The copy-paste setup prompts, rendered from the ONE shared registry
// (lib/setup-prompts.ts) that the in-app onboarding modals and /llms.txt also
// render. The prompt text is never duplicated here. Both base URLs are resolved
// for THIS deployment — the API through the docs resolver, the web origin from
// the request — so a self-hosted stack never mixes its API with the hosted web
// host.
export default async function SetupPromptsDocsPage() {
  const apiBaseUrl = docsApiBaseUrl();
  const webBaseUrl = webBaseUrlFromHeaders(await headers()) ?? PLATFORM_WEB_URL;
  const prompts = buildSetupPrompts(webBaseUrl, apiBaseUrl);
  return (
    <>
      <DocsPageHeader
        eyebrow="Get started"
        title="Setup prompts"
        lede="Paste one of these into your coding agent and it will do the setup for you: create an account, wire an OpenAI client to the gateway, connect your keys, or land your traces. Each prompt is first-person, so pasting it is your instruction and consent."
      />

      <DocsSection id="how-to-use" title="How to use them">
        <Prose>
          Copy a prompt below and paste it into a CLI coding agent (Claude Code,
          Codex, and the like). The agent follows it end to end. The prompts are
          the same ones the in-app onboarding uses, and they carry this
          deployment&apos;s URLs (web <Code>{webBaseUrl}</Code>, API{" "}
          <Code>{apiBaseUrl}</Code>).
        </Prose>
        <Callout>
          Agents can also read every prompt from{" "}
          <a className="text-ink underline underline-offset-2" href="/llms.txt">
            /llms.txt
          </a>
          , the machine-readable reference. Shareable copies live in the{" "}
          <a
            className="text-ink underline underline-offset-2"
            href={SETUP_PROMPTS_REPO_URL}
            rel="noreferrer"
            target="_blank"
          >
            setup-prompts repository
          </a>
          .
        </Callout>
      </DocsSection>

      {prompts.map((entry) => (
        <DocsSection key={entry.id} id={entry.id} title={entry.title}>
          <Prose>{entry.description}</Prose>
          <CodeBlock code={entry.prompt} language="markdown" title="prompt" />
        </DocsSection>
      ))}

      <DocsSection id="more" title="See also">
        <Prose>
          Prefer to wire it by hand? The{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/quickstart">
            Quickstart
          </Link>{" "}
          makes the first call in a minute, and{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/coding-agents">
            Coding agents
          </Link>{" "}
          has per-agent configuration.
        </Prose>
      </DocsSection>
    </>
  );
}
