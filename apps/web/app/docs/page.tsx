import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { Callout, Code, DocsList, DocsSection, Prose } from "@/components/docs/DocsContent";
import { DOCS_PAGES } from "@/components/docs/docs-nav";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import type { CodeLanguage } from "@/components/docs/code-language";

export const metadata = { title: "Overview" };

// The docs landing page: what the gateway is, the one call that proves the
// base_url swap, and the map into the rest of the docs. Accurate to the shipped
// /v1 edge proxy in front of the Experiential gateway worker.
export default function DocsOverviewPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Get started"
        title="Overview"
        lede={
          <>
            Experiential Labs is an OpenAI-compatible model gateway: one base URL
            in front of every model: hosted providers, your own provider keys,
            our platform-funded credits, and self-hosted or custom models. Point
            an OpenAI client at it and change nothing else.
          </>
        }
      />

      <DocsSection id="base-url-swap" title="The base-url swap">
        <Prose>
          Everything starts here. Keep your existing OpenAI integration and point
          it at <Code>{baseUrl}/v1</Code> with an Experiential Labs key. The
          gateway speaks the OpenAI wire protocol for both Chat Completions and
          the Responses API, streaming included, so the only lines that change
          are the base URL and the key.
        </Prose>
        <CodeTabs snippets={firstCallSnippets(baseUrl)} title="POST /v1/chat/completions" />
        <Prose>
          Ready to run it end to end? The{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/quickstart">
            Quickstart
          </Link>{" "}
          takes you from signing in to a streamed response in under a minute.
        </Prose>
      </DocsSection>

      <DocsSection id="how-it-works" title="How it works">
        <Prose>
          A request names a model by its <Code>slug</Code> (for example{" "}
          <Code>claude-opus-5</Code>). The gateway resolves that slug through a
          per-model <em>provider waterfall</em>, an ordered list of ways to
          reach the model, trying each rung and failing over on capacity or
          transport errors until one succeeds. You get the first good response;
          the routing is invisible.
        </Prose>
        <Prose>
          Experiential Cloud is a curated collection of models, hosted and
          optimized by Experiential Labs. Call those slugs with your Experiential
          Labs key.
        </Prose>
        <Prose>Every model is paid for through one of two lanes, with no markup either way:</Prose>
        <DocsList>
          <li>
            <strong className="font-medium text-ink">Pass-through (BYOK)</strong>: your
            own provider key. The provider bills you directly; we add nothing.
          </li>
          <li>
            <strong className="font-medium text-ink">Platform-funded</strong>: our
            credits, priced from the public catalog. Each call draws down your
            balance.
          </li>
        </DocsList>
        <Callout>
          Everything the web app can do, an agent can do over the API: list and
          browse models, call them, connect provider keys, add custom models,
          edit waterfalls, and read usage, all with the same org API key.
        </Callout>
      </DocsSection>

      <DocsSection id="whats-here" title="What's in these docs">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {DOCS_PAGES.filter((entry) => entry.path !== "/docs").map((entry) => (
            <li key={entry.path}>
              <Link
                className="group flex flex-col gap-0.5 rounded-md border border-line bg-surface px-3.5 py-2.5 hover:border-line-strong"
                href={entry.path}
              >
                <span className="text-[13.5px] font-medium text-ink group-hover:text-accent">
                  {entry.title}
                </span>
                <span className="text-[12.5px] text-muted">{entry.description}</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mb-0 mt-6 text-[13px] leading-relaxed text-muted">
          Agents and tools should read{" "}
          <a className="text-ink underline underline-offset-2" href="/llms.txt">
            /llms.txt
          </a>
          , the complete machine-readable reference.
        </p>
      </DocsSection>
    </>
  );
}

// The base_url swap in all three languages, interpolated through the one
// base-URL module so a domain change is a deploy/env change, never a docs edit.
function firstCallSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl "${baseUrl}/v1/chat/completions" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "claude-opus-5", "messages": [{"role": "user", "content": "Hello"}]}'`
    ].join("\n"),
    python: [
      "import os",
      "",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["EXPLABS_API_KEY"])`,
      "response = client.chat.completions.create(",
      '    model="claude-opus-5",',
      '    messages=[{"role": "user", "content": "Hello"}],',
      ")",
      "print(response.choices[0].message.content)"
    ].join("\n"),
    javascript: [
      'import OpenAI from "openai";',
      "",
      "const client = new OpenAI({",
      `  baseURL: "${baseUrl}/v1",`,
      "  apiKey: process.env.EXPLABS_API_KEY,",
      "});",
      "const response = await client.chat.completions.create({",
      '  model: "claude-opus-5",',
      '  messages: [{ role: "user", content: "Hello" }],',
      "});",
      "console.log(response.choices[0].message.content);"
    ].join("\n")
  };
}
