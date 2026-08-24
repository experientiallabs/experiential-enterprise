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

export const metadata = { title: "Authentication" };

// How a customer authenticates to the gateway: the xpl_ key shape, the one
// Bearer header, the keyless catalog exception, and the exact boundary of what
// one org key can do. Accurate to the customer-key allowlist in
// explabs/api/app.py and the auth envelope the gateway worker returns.
export default function AuthenticationDocsPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Get started"
        title="Authentication"
        lede="One organization key authenticates every call: inference on /v1 and the management API on /api. It rides in a single Authorization header and is scoped to exactly one organization."
      />

      <DocsSection id="the-key" title="The key">
        <Prose>
          A key looks like <Code>xpl_</Code> followed by 40 lowercase hex
          characters and belongs to exactly one organization. The secret is shown
          once, at creation, so copy it then. Mint keys signed in at{" "}
          <Link className="text-ink underline underline-offset-2" href="/api-keys">
            Settings, API keys
          </Link>
          . Creating and revoking keys is a web-session action, not something an
          API key can do.
        </Prose>
        <Prose>
          Export the key for the snippets throughout these docs:{" "}
          <Code>export EXPLABS_API_KEY=xpl_...</Code>
        </Prose>
      </DocsSection>

      <DocsSection id="the-header" title="The header">
        <Prose>
          Send the key as a Bearer token on every request:{" "}
          <Code>Authorization: Bearer &lt;key&gt;</Code>. There is no query-string
          key and no cookie. Verify a key works by listing the models it can
          call:
        </Prose>
        <CodeTabs snippets={verifySnippets(baseUrl)} title="GET /v1/models" />
        <Prose>
          The one exception is the public catalog. The catalog reads (
          <Code>GET /api/models*</Code>) are keyless: without a key you get the
          public rows, and sending your key adds the rows your organization owns.
          Everything else, including the OpenAI-compatible{" "}
          <Code>GET /v1/models</Code>, requires your key.
        </Prose>
        <Callout>
          The Anthropic Messages lane at <Code>/v1/messages</Code> additionally
          accepts the Anthropic-style <Code>x-api-key: &lt;key&gt;</Code> header
          with the same <Code>xpl_</Code> key, so Anthropic SDKs authenticate
          unchanged. See{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/anthropic">
            the Anthropic API
          </Link>
          .
        </Callout>
      </DocsSection>

      <DocsSection id="what-a-key-can-do" title="What one key can do">
        <Prose>
          The same Bearer key that runs inference also reaches the management
          surface an agent needs. Every write acts for the key&apos;s own
          organization; tenancy scopes each call to it. With one key you can:
        </Prose>
        <DocsList>
          <li>Call models on <Code>/v1</Code> (Chat Completions, Responses, and Anthropic Messages).</li>
          <li>Read the catalog and your org&apos;s custom and local models.</li>
          <li>Create custom and local models and edit provider waterfalls.</li>
          <li>Connect and verify BYOK provider connections (secrets are write-only).</li>
          <li>Read your usage, spend, and the org&apos;s key list.</li>
        </DocsList>
        <Prose>A customer key deliberately cannot:</Prose>
        <DocsList>
          <li>Mint or revoke API keys — that is a web-session action (<Code>POST /api/keys</Code> is not key-callable).</li>
          <li>Change another key&apos;s limits.</li>
          <li>Reach platform-admin routes.</li>
        </DocsList>
      </DocsSection>

      <DocsSection id="failures" title="When auth fails">
        <Prose>
          A missing, malformed, expired, or revoked key returns a uniform{" "}
          <Code>401</Code> with <Code>code=invalid_key</Code>; the response does
          not distinguish which of those it was.
        </Prose>
        <pre className="docs-code my-4 overflow-x-auto rounded-lg border border-line bg-surface p-4 font-mono text-[12.5px] leading-relaxed text-ink">
          {`{
  "error": {
    "message": "The API key is missing, invalid, or has been revoked.",
    "type": "authentication_error",
    "code": "invalid_key",
    "param": null
  }
}`}
        </pre>
        <Prose>
          Fix the <Code>Authorization</Code> header rather than retrying; the same
          call fails the same way. On <Code>/v1/messages</Code> the same failure
          arrives in Anthropic&apos;s envelope instead. See{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/errors">
            Errors
          </Link>{" "}
          for every code.
        </Prose>
      </DocsSection>

      <DocsSection id="more" title="See also">
        <Prose>
          Walk the full self-serve loop in{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/core-loop">
            The core loop
          </Link>
          , or read the complete surface in the{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/reference">
            API reference
          </Link>
          . Agents can read{" "}
          <a className="text-ink underline underline-offset-2" href="/llms.txt">
            /llms.txt
          </a>{" "}
          for the same contract in one file.
        </Prose>
      </DocsSection>
    </>
  );
}

function verifySnippets(baseUrl: string): Record<CodeLanguage, string> {
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
