import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeTabs } from "@/components/docs/CodeTabs";
import {
  Callout,
  Code,
  DocsList,
  DocsSection,
  Prose
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import type { CodeLanguage } from "@/components/docs/code-language";

export const metadata = { title: "Anthropic API" };

// Calling the gateway with the Anthropic Messages API. The lane is a
// platform-owned translation over the same chat dispatch path
// (explabs/gateway/anthropic_messages.py): it accepts x-api-key or Bearer,
// serves any catalog slug, streams Anthropic SSE, wraps errors in Anthropic's
// envelope, and drops the features the chat surface cannot express. Kept
// faithful to those shipped limits.
export default function AnthropicDocsPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Guides"
        title="Anthropic API"
        lede="The gateway serves the Anthropic Messages API at /v1/messages, so the Anthropic SDKs and Claude Code work against it unchanged. It is a translation onto the same chat surface, so every catalog model is reachable, not just Claude."
      />

      <DocsSection id="endpoint" title="The endpoint">
        <Prose>
          <Code>POST {baseUrl}/v1/messages</Code> speaks the Anthropic Messages
          wire protocol. Authenticate with the Anthropic-style{" "}
          <Code>x-api-key</Code> header or with{" "}
          <Code>Authorization: Bearer</Code>, either carries the same{" "}
          <Code>xpl_</Code> key. Name any slug from{" "}
          <Code>GET {baseUrl}/v1/models</Code> as the model.
        </Prose>
        <CodeTabs snippets={messagesSnippets(baseUrl)} title="POST /v1/messages" />
      </DocsSection>

      <DocsSection id="streaming" title="Streaming">
        <Prose>
          Set <Code>stream: true</Code> to receive Anthropic&apos;s server-sent
          event stream (<Code>message_start</Code>,{" "}
          <Code>content_block_delta</Code>, <Code>message_stop</Code>, and the
          rest), exactly as the Anthropic SDKs expect.
        </Prose>
        <CodeTabs snippets={streamSnippets(baseUrl)} title="Streaming" />
      </DocsSection>

      <DocsSection id="limits" title="What the translation lane drops">
        <Prose>
          Because the lane maps onto the gateway&apos;s text-only chat surface,
          a few Anthropic features are deliberately unavailable:
        </Prose>
        <DocsList>
          <li>
            <strong className="font-medium text-ink">Extended thinking</strong> is
            not available. A <Code>thinking</Code> config and thinking blocks are
            accepted and dropped, never returned.
          </li>
          <li>
            <strong className="font-medium text-ink">Image and document blocks</strong>{" "}
            are rejected with <Code>400</Code>; the chat surface is text-only.
          </li>
          <li>
            <Code>Idempotency-Key</Code> is not honored on this lane (Anthropic
            defines none).
          </li>
          <li>
            <Code>/v1/messages/count_tokens</Code> is not served.
          </li>
        </DocsList>
        <Callout tone="warning">
          Errors on <Code>/v1/messages</Code> use Anthropic&apos;s envelope,{" "}
          <Code>{`{"type":"error","error":{"type":"invalid_request_error","message":"..."}}`}</Code>
          , at the same HTTP statuses as the OpenAI routes. Branch on the status
          and the Anthropic error <Code>type</Code>; the underlying meanings match
          the{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/errors">
            Errors
          </Link>{" "}
          table.
        </Callout>
      </DocsSection>

      <DocsSection id="claude-code" title="Claude Code and other agents">
        <Prose>
          Claude Code connects through this same lane by pointing{" "}
          <Code>ANTHROPIC_BASE_URL</Code> at the gateway and passing an{" "}
          <Code>xpl_</Code> key as <Code>ANTHROPIC_AUTH_TOKEN</Code>. The
          per-agent configuration is in{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/coding-agents">
            Coding agents
          </Link>
          .
        </Prose>
      </DocsSection>

      <DocsSection id="more" title="See also">
        <Prose>
          Prefer the OpenAI protocol? The{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/quickstart">
            Quickstart
          </Link>{" "}
          covers Chat Completions and the Responses API. The full surface is in
          the{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/reference">
            API reference
          </Link>
          .
        </Prose>
      </DocsSection>
    </>
  );
}

function messagesSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl "${baseUrl}/v1/messages" \\`,
      '  -H "x-api-key: $EXPLABS_API_KEY" \\',
      '  -H "anthropic-version: 2023-06-01" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "qwen3.8-27b", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'`
    ].join("\n"),
    python: [
      "import os",
      "",
      "from anthropic import Anthropic",
      "",
      `client = Anthropic(base_url="${baseUrl}", api_key=os.environ["EXPLABS_API_KEY"])`,
      "message = client.messages.create(",
      '    model="qwen3.8-27b",',
      "    max_tokens=1024,",
      '    messages=[{"role": "user", "content": "Hello"}],',
      ")",
      "print(message.content[0].text)"
    ].join("\n"),
    javascript: [
      'import Anthropic from "@anthropic-ai/sdk";',
      "",
      "const client = new Anthropic({",
      `  baseURL: "${baseUrl}",`,
      "  apiKey: process.env.EXPLABS_API_KEY,",
      "});",
      "const message = await client.messages.create({",
      '  model: "qwen3.8-27b",',
      "  max_tokens: 1024,",
      '  messages: [{ role: "user", content: "Hello" }],',
      "});",
      "console.log(message.content[0].text);"
    ].join("\n")
  };
}

function streamSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl -N "${baseUrl}/v1/messages" \\`,
      '  -H "x-api-key: $EXPLABS_API_KEY" \\',
      '  -H "anthropic-version: 2023-06-01" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "qwen3.8-27b", "max_tokens": 1024, "stream": true, "messages": [{"role": "user", "content": "Hello"}]}'`
    ].join("\n"),
    python: [
      "import os",
      "",
      "from anthropic import Anthropic",
      "",
      `client = Anthropic(base_url="${baseUrl}", api_key=os.environ["EXPLABS_API_KEY"])`,
      "with client.messages.stream(",
      '    model="qwen3.8-27b",',
      "    max_tokens=1024,",
      '    messages=[{"role": "user", "content": "Hello"}],',
      ") as stream:",
      "    for text in stream.text_stream:",
      '        print(text, end="")'
    ].join("\n"),
    javascript: [
      'import Anthropic from "@anthropic-ai/sdk";',
      "",
      "const client = new Anthropic({",
      `  baseURL: "${baseUrl}",`,
      "  apiKey: process.env.EXPLABS_API_KEY,",
      "});",
      "const stream = await client.messages.create({",
      '  model: "qwen3.8-27b",',
      "  max_tokens: 1024,",
      '  messages: [{ role: "user", content: "Hello" }],',
      "  stream: true,",
      "});",
      "for await (const event of stream) {",
      '  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {',
      "    process.stdout.write(event.delta.text);",
      "  }",
      "}"
    ].join("\n")
  };
}
