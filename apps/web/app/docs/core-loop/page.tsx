import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeTabs } from "@/components/docs/CodeTabs";
import {
  Callout,
  Code,
  DocsSection,
  DocsSubheading,
  Prose
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import type { CodeLanguage } from "@/components/docs/code-language";

export const metadata = { title: "The core loop" };

// The agent self-serve loop, each step a copy-pasteable call: get a key, list
// models, call one, read usage. One org Bearer key drives all of it.
export default function CoreLoopDocsPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Get started"
        title="The core loop"
        lede="Everything a human does in the web app, an agent can do over the API with one organization key: get a key, list models, call them, and read usage."
      />

      <DocsSection id="get-key" title="1. Get a key">
        <Prose>
          Keys are minted in the web app at{" "}
          <Link className="text-ink underline underline-offset-2" href="/api-keys">
            Settings, API keys
          </Link>{" "}
          and shown once. Creating and revoking keys is a web-session action:{" "}
          <Code>POST /api/keys</Code> is not callable with an API key. One key
          then drives every step below. Export it:{" "}
          <Code>export EXPLABS_API_KEY=xpl_...</Code>
        </Prose>
      </DocsSection>

      <DocsSection id="list-models" title="2. List models">
        <Prose>
          <Code>GET /v1/models</Code> returns the slugs your key can call: the
          public catalog plus your org&apos;s own custom and local models.
        </Prose>
        <CodeTabs snippets={listModelsSnippets(baseUrl)} title="GET /v1/models" />
      </DocsSection>

      <DocsSection id="call" title="3. Call a model">
        <Prose>
          Call any slug from that list exactly as you would call OpenAI. This is
          the same request shape as the{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/quickstart">
            Quickstart
          </Link>
          .
        </Prose>
        <CodeTabs snippets={callSnippets(baseUrl)} title="POST /v1/chat/completions" />
      </DocsSection>

      <DocsSection id="usage" title="4. Read your usage">
        <Prose>
          Read your own spend and token usage with the same key.{" "}
          <Code>GET /api/gateway/usage/daily</Code> takes an <Code>org_id</Code>{" "}
          and returns a grouped rollup. An API key reads at <Code>scope=org</Code>
          ; <Code>scope=self</Code> needs an end-user session.
        </Prose>
        <CodeTabs snippets={usageSnippets(baseUrl)} title="GET /api/gateway/usage/daily" />
        <Prose>
          To see how your org resolves each alias, and which lane it rides, read{" "}
          <Code>GET /api/gateway/catalog?org_id=&lt;ORG_ID&gt;</Code>.
        </Prose>
      </DocsSection>

      <Callout>
        The same Bearer key that does inference also reaches the management
        surface an agent needs: catalog reads, custom-model and waterfall writes,
        BYOK provider connections, usage reads, and the org&apos;s key list. It
        cannot mint or revoke keys, change another key&apos;s limits, or reach
        platform-admin routes. See the{" "}
        <Link className="text-ink underline underline-offset-2" href="/docs/reference">
          API reference
        </Link>{" "}
        for the full surface.
      </Callout>

      <DocsSection id="cli" title="From the terminal">
        <DocsSubheading>Self-hosted</DocsSubheading>
        <Prose>
          Self-hosters run the open-source Experiential gateway from the terminal
          with <Code>exp run</Code>. The hosted platform manages the catalog,
          keys, and usage for you in the web app, so on the hosted gateway the
          loop above is the whole story.
        </Prose>
      </DocsSection>

      <DocsSection id="more" title="See also">
        <Prose>
          The{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/reference">
            API reference
          </Link>{" "}
          lists every endpoint, and{" "}
          <a className="text-ink underline underline-offset-2" href="/llms.txt">
            /llms.txt
          </a>{" "}
          carries this loop in one machine-readable file.
        </Prose>
      </DocsSection>
    </>
  );
}

function listModelsSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl "${baseUrl}/v1/models" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY"'
    ].join("\n"),
    python: [
      "import os",
      "",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["EXPLABS_API_KEY"])`,
      "for model in client.models.list().data:",
      "    print(model.id)"
    ].join("\n"),
    javascript: [
      'import OpenAI from "openai";',
      "",
      "const client = new OpenAI({",
      `  baseURL: "${baseUrl}/v1",`,
      "  apiKey: process.env.EXPLABS_API_KEY,",
      "});",
      "const models = await client.models.list();",
      "for (const model of models.data) console.log(model.id);"
    ].join("\n")
  };
}

function callSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl "${baseUrl}/v1/chat/completions" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "qwen3.8-27b", "messages": [{"role": "user", "content": "Hello"}]}'`
    ].join("\n"),
    python: [
      "import os",
      "",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["EXPLABS_API_KEY"])`,
      "response = client.chat.completions.create(",
      '    model="qwen3.8-27b",',
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
      '  model: "qwen3.8-27b",',
      '  messages: [{ role: "user", content: "Hello" }],',
      "});",
      "console.log(response.choices[0].message.content);"
    ].join("\n")
  };
}

function usageSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl "${baseUrl}/api/gateway/usage/daily?org_id=$ORG_ID&scope=org&group_by=day" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY"'
    ].join("\n"),
    python: [
      "import os",
      "import httpx",
      "",
      'headers = {"Authorization": f"Bearer {os.environ[\'EXPLABS_API_KEY\']}"}',
      "resp = httpx.get(",
      `    "${baseUrl}/api/gateway/usage/daily",`,
      '    params={"org_id": os.environ["ORG_ID"], "scope": "org", "group_by": "day"},',
      "    headers=headers,",
      ")",
      'for row in resp.json()["rows"]:',
      '    print(row["day"], row["requests"], row["spend_micro_usd"])'
    ].join("\n"),
    javascript: [
      'const headers = { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` };',
      "const params = new URLSearchParams({",
      "  org_id: process.env.ORG_ID,",
      '  scope: "org",',
      '  group_by: "day",',
      "});",
      `const resp = await fetch(\`${baseUrl}/api/gateway/usage/daily?\${params}\`, { headers });`,
      "const { rows } = await resp.json();",
      "for (const row of rows) console.log(row.day, row.requests, row.spend_micro_usd);"
    ].join("\n")
  };
}
