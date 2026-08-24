import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { Callout, Code, DocsSection, DocsSteps, Prose } from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import type { CodeLanguage } from "@/components/docs/code-language";

export const metadata = { title: "Quickstart" };

// Sign in, copy a key, and make a first call in under a minute. Every snippet
// is the base_url swap against the shipped /v1 surface, runnable as written.
export default function QuickstartDocsPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Get started"
        title="Quickstart"
        lede="Point your existing OpenAI client at the gateway and make your first call in under a minute. Chat Completions and the Responses API, streaming included."
      />

      <DocsSection id="get-a-key" title="Get a key">
        <DocsSteps>
          <li>
            Sign in and open{" "}
            <Link className="text-ink underline underline-offset-2" href="/api-keys">
              Settings, API keys
            </Link>
            .
          </li>
          <li>
            Create a key. The secret (<Code>xpl_...</Code>) is shown once, so copy
            it now.
          </li>
          <li>
            Export it for the snippets below:{" "}
            <Code>export EXPLABS_API_KEY=xpl_...</Code>
          </li>
        </DocsSteps>
        <Prose>
          For the pass-through lane, also connect a provider key in{" "}
          <Link className="text-ink underline underline-offset-2" href="/settings">
            Settings
          </Link>
          . For the platform-funded lane, nothing more is needed: calls draw down
          your credits.
        </Prose>
      </DocsSection>

      <DocsSection id="first-call" title="Your first call">
        <Prose>
          Set <Code>base_url</Code> to <Code>{baseUrl}/v1</Code> and pass a model{" "}
          <Code>slug</Code>. Everything else is the standard OpenAI request.
        </Prose>
        <CodeTabs snippets={chatSnippets(baseUrl)} title="POST /v1/chat/completions" />
      </DocsSection>

      <DocsSection id="streaming" title="Stream the response">
        <Prose>
          Set <Code>stream: true</Code> to receive server-sent events as tokens
          arrive.
        </Prose>
        <CodeTabs snippets={streamSnippets(baseUrl)} title="Streaming" />
      </DocsSection>

      <DocsSection id="responses" title="Use the Responses API">
        <Prose>
          The gateway also serves the OpenAI Responses API at{" "}
          <Code>/v1/responses</Code>, streaming included.
        </Prose>
        <CodeTabs snippets={responsesSnippets(baseUrl)} title="POST /v1/responses" />
        <Callout>
          <Code>previous_response_id</Code> continues a prior response on any
          worker instance. Continuations are retained for a bounded window; an
          unknown or expired id fails closed with{" "}
          <Code>400 continuation_unavailable</Code>, in which case resend the
          full conversation.
        </Callout>
      </DocsSection>

      <DocsSection id="next" title="Next">
        <Prose>
          Walk the full self-serve loop in{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/core-loop">
            The core loop
          </Link>
          , or see how the catalog and provider waterfalls work in{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/models">
            Models
          </Link>
          .
        </Prose>
      </DocsSection>
    </>
  );
}

function chatSnippets(baseUrl: string): Record<CodeLanguage, string> {
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

function streamSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl -N "${baseUrl}/v1/chat/completions" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "claude-opus-5", "stream": true, "messages": [{"role": "user", "content": "Hello"}]}'`
    ].join("\n"),
    python: [
      "import os",
      "",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["EXPLABS_API_KEY"])`,
      "stream = client.chat.completions.create(",
      '    model="claude-opus-5",',
      '    messages=[{"role": "user", "content": "Hello"}],',
      "    stream=True,",
      ")",
      "for chunk in stream:",
      "    print(chunk.choices[0].delta.content or \"\", end=\"\")"
    ].join("\n"),
    javascript: [
      'import OpenAI from "openai";',
      "",
      "const client = new OpenAI({",
      `  baseURL: "${baseUrl}/v1",`,
      "  apiKey: process.env.EXPLABS_API_KEY,",
      "});",
      "const stream = await client.chat.completions.create({",
      '  model: "claude-opus-5",',
      '  messages: [{ role: "user", content: "Hello" }],',
      "  stream: true,",
      "});",
      "for await (const chunk of stream) {",
      "  process.stdout.write(chunk.choices[0].delta.content ?? \"\");",
      "}"
    ].join("\n")
  };
}

function responsesSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl "${baseUrl}/v1/responses" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "claude-opus-5", "input": "Hello"}'`
    ].join("\n"),
    python: [
      "import os",
      "",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["EXPLABS_API_KEY"])`,
      "response = client.responses.create(",
      '    model="claude-opus-5",',
      '    input="Hello",',
      ")",
      "print(response.output_text)"
    ].join("\n"),
    javascript: [
      'import OpenAI from "openai";',
      "",
      "const client = new OpenAI({",
      `  baseURL: "${baseUrl}/v1",`,
      "  apiKey: process.env.EXPLABS_API_KEY,",
      "});",
      "const response = await client.responses.create({",
      '  model: "claude-opus-5",',
      '  input: "Hello",',
      "});",
      "console.log(response.output_text);"
    ].join("\n")
  };
}
