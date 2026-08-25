import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeTabs } from "@/components/docs/CodeTabs";
import {
  Callout,
  Code,
  DocsList,
  DocsSection,
  DocsTable,
  Prose
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import type { CodeLanguage } from "@/components/docs/code-language";
import { EXPERIENTIAL_CLOUD_DESCRIPTION } from "@/lib/models-catalog/format";

export const metadata = { title: "Models" };

// How the catalog, provider waterfalls, the two payment lanes, and custom /
// local models work. Accurate to the shipped models catalog + provider
// connection routes.

const PROVIDER_COLUMNS = [
  { key: "provider", header: "provider", mono: true },
  { key: "needs", header: "A connection needs" }
] as const;

const PROVIDER_ROWS = [
  { provider: "openai", needs: "An API key (sk-...)." },
  { provider: "anthropic", needs: "An API key." },
  { provider: "gemini", needs: "An API key." },
  { provider: "openrouter", needs: "An API key." },
  { provider: "fireworks", needs: "An API key (and account id)." },
  {
    provider: "azure_openai",
    needs: "A key, the resource endpoint, an api_version, and a model-to-deployment map."
  },
  { provider: "bedrock", needs: "AWS credentials and a region." },
  { provider: "local", needs: "A base_url pointing at your OpenAI-compatible server." },
  { provider: "modal", needs: "A base_url and a Modal token pair." },
  {
    provider: "experiential_cloud",
    needs: `${EXPERIENTIAL_CLOUD_DESCRIPTION} Nothing to connect, call these slugs with your Experiential Labs key.`
  }
];

export default function ModelsDocsPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Guides"
        title="Models"
        lede="The catalog is every model you can call by slug. Each slug resolves through a provider waterfall, paid for through your own provider key or platform credits."
      />

      <DocsSection id="catalog" title="The catalog">
        <Prose>
          Every model is a <Code>slug</Code> (for example <Code>claude-opus-5</Code>,{" "}
          <Code>gpt-5.5</Code>, <Code>gemini-3.7-flash</Code>) with a display name,
          context window, input and output modalities, and pricing. The catalog is
          the public rows plus your organization&apos;s own custom and local
          models. Browse it in the web app at{" "}
          <Link className="text-ink underline underline-offset-2" href="/models">
            /models
          </Link>
          , or read it over the API: <Code>GET /api/models</Code> is public and
          needs no key (it returns the public rows), and sending your key adds your
          organization&apos;s own custom and local models.
        </Prose>
        <Prose>
          Experiential Cloud is a curated collection of models, hosted and
          optimized by Experiential Labs. Those slugs appear in the catalog like
          any other model. Call them with your Experiential Labs key. They are
          not a provider connection you attach yourself.
        </Prose>
        <CodeTabs snippets={listCatalogSnippets(baseUrl)} title="GET /api/models" />
        <Prose>
          Filter and sort with query parameters: <Code>modality</Code>,{" "}
          <Code>category</Code>, <Code>provider</Code>, <Code>min_context</Code>,{" "}
          <Code>max_input_micro_usd_per_million</Code>, <Code>supports</Code>, and{" "}
          <Code>sort</Code> (one of <Code>preferred</Code>, <Code>price</Code>,{" "}
          <Code>age</Code>, <Code>context</Code>, <Code>throughput</Code>) with{" "}
          <Code>limit</Code> and <Code>offset</Code>. One model&apos;s detail is{" "}
          <Code>GET /api/models/&lt;slug&gt;</Code>; its deployments are{" "}
          <Code>GET /api/models/&lt;slug&gt;/providers</Code>.
        </Prose>
      </DocsSection>

      <DocsSection id="waterfalls" title="Provider waterfalls">
        <Prose>
          A slug does not point at one provider; it points at a{" "}
          <em>waterfall</em>, an ordered list of deployments (each a provider plus
          a provider model id, and for some providers a <Code>base_url</Code>,{" "}
          <Code>region</Code>, or <Code>api_version</Code>). The gateway tries each
          rung in order, fails over on capacity and transport errors, and returns
          the first success. The routing is invisible to the caller: you get one
          OpenAI-shaped response.
        </Prose>
        <Prose>
          Every model has a default chain. An organization can override it with its
          own ordering. Read and replace the chain with the waterfall endpoints;{" "}
          <Code>model_provider_ids</Code> is the ordered list of deployment ids, and
          an empty list clears your override (falling back to the default).
        </Prose>
        <CodeTabs snippets={waterfallSnippets(baseUrl)} title="GET / PUT /api/models/{slug}/waterfall" />
      </DocsSection>

      <DocsSection id="lanes" title="Two lanes: BYOK and platform-funded">
        <Prose>
          Each deployment is paid for through one of two lanes, and the gateway
          adds no markup on either:
        </Prose>
        <DocsList>
          <li>
            <strong className="font-medium text-ink">Pass-through (BYOK)</strong>:
            your own provider key. The provider bills you directly. These
            deployments are <Code>customer_managed</Code>.
          </li>
          <li>
            <strong className="font-medium text-ink">Platform-funded</strong>: our
            credits, priced from the public catalog. These deployments are{" "}
            <Code>host_managed</Code> and are seeded by operations, never
            self-asserted.
          </li>
        </DocsList>
        <Prose>
          To use the pass-through lane, connect a provider key. Connecting or
          rotating a key is a single upsert; verify it with a check call. Keys are
          write-only: reads never return secret material.
        </Prose>
        <CodeTabs
          snippets={connectionSnippets(baseUrl)}
          title="PUT /api/orgs/{org_id}/provider-connections/{provider}"
        />
        <Prose>Each provider is connected differently:</Prose>
        <DocsTable columns={PROVIDER_COLUMNS} rows={PROVIDER_ROWS} />
        <Callout>
          The web app&apos;s <Link className="text-ink underline underline-offset-2" href="/settings">
            Settings
          </Link>{" "}
          page walks each provider&apos;s fields with the right form, and the model
          page&apos;s &quot;use via key&quot; flow connects one in context.
        </Callout>
      </DocsSection>

      <DocsSection id="provenance" title="Estimated vs measured stats">
        <Prose>
          Every route carries the source of its numbers so you can tell a seeded
          estimate from something we measured on our own serving, and a field
          flips from estimate to measured once we have enough volume to trust it:
        </Prose>
        <DocsList>
          <li>
            <strong className="font-medium text-ink">Stats</strong> (uptime,
            throughput, latency): seeded values are{" "}
            <Code>stats_source = &apos;openrouter&apos;</Code>. Once a route has
            enough completed requests in the trailing 30 days, the catalog overlays
            values measured from our usage ledger and marks them{" "}
            <Code>stats_source = &apos;observed&apos;</Code>. Below that floor the
            seeded estimate stands.
          </li>
          <li>
            <strong className="font-medium text-ink">Pricing</strong>: real prices
            carry their source (<Code>openrouter</Code>, <Code>provider-docs</Code>,{" "}
            <Code>aws-price-list</Code>); a value we had to guess is{" "}
            <Code>pricing_source = &apos;estimate&apos;</Code> and is display-only , 
            an estimated price is never billed or served on the platform lane.
          </li>
        </DocsList>
      </DocsSection>

      <DocsSection id="custom" title="Custom and local models">
        <Prose>
          Add your own model as an ordinary catalog row scoped to your org: one
          model plus at least one deployment. A <Code>local</Code> deployment
          points at any OpenAI-compatible server through its <Code>base_url</Code>,
          so a model you host yourself is callable by slug just like a hosted one.
        </Prose>
        <CodeTabs snippets={customModelSnippets(baseUrl)} title="POST /api/models" />
        <Prose>
          To add another way to reach an existing model (a local variant, a second
          provider), post a deployment to{" "}
          <Code>POST /api/models/&lt;slug&gt;/providers</Code>, then add it to the
          waterfall.
        </Prose>
      </DocsSection>

      <DocsSection id="more" title="See also">
        <Prose>
          The{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/reference">
            API reference
          </Link>{" "}
          lists every field and response shape, and{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/errors">
            Errors
          </Link>{" "}
          covers what a failed route returns.
        </Prose>
      </DocsSection>
    </>
  );
}

function listCatalogSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: `curl "${baseUrl}/api/models?sort=preferred&limit=20"`,
    python: [
      "import httpx",
      "",
      `resp = httpx.get("${baseUrl}/api/models", params={"sort": "preferred", "limit": 20})`,
      'for entry in resp.json()["models"]:',
      '    print(entry["model"]["slug"], entry["model"]["display_name"])'
    ].join("\n"),
    javascript: [
      `const resp = await fetch("${baseUrl}/api/models?sort=preferred&limit=20");`,
      "const { models } = await resp.json();",
      "for (const entry of models) {",
      "  console.log(entry.model.slug, entry.model.display_name);",
      "}"
    ].join("\n")
  };
}

function waterfallSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `# Read the chain for a model`,
      `curl "${baseUrl}/api/models/claude-opus-5/waterfall" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY"',
      "",
      "# Replace your org's override with an ordered deployment list",
      `curl -X PUT "${baseUrl}/api/models/claude-opus-5/waterfall" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model_provider_ids": ["<deployment-a>", "<deployment-b>"]}'`
    ].join("\n"),
    python: [
      "import os",
      "import httpx",
      "",
      'headers = {"Authorization": f"Bearer {os.environ[\'EXPLABS_API_KEY\']}"}',
      `base = "${baseUrl}/api/models/claude-opus-5/waterfall"`,
      "",
      "chain = httpx.get(base, headers=headers).json()",
      "print([rung['model_provider_id'] for rung in chain['default']])",
      "",
      "httpx.put(",
      "    base,",
      "    headers=headers,",
      '    json={"model_provider_ids": ["<deployment-a>", "<deployment-b>"]},',
      ")"
    ].join("\n"),
    javascript: [
      'const headers = { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` };',
      `const base = "${baseUrl}/api/models/claude-opus-5/waterfall";`,
      "",
      "const chain = await (await fetch(base, { headers })).json();",
      "console.log(chain.default.map((rung) => rung.model_provider_id));",
      "",
      "await fetch(base, {",
      '  method: "PUT",',
      '  headers: { ...headers, "Content-Type": "application/json" },',
      '  body: JSON.stringify({ model_provider_ids: ["<deployment-a>", "<deployment-b>"] }),',
      "});"
    ].join("\n")
  };
}

function connectionSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl -X PUT "${baseUrl}/api/orgs/$ORG_ID/provider-connections/openai" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '{"secret": "sk-...", "config": {}}'`,
      "",
      "# Verify it",
      `curl -X POST "${baseUrl}/api/orgs/$ORG_ID/provider-connections/openai/check" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY"'
    ].join("\n"),
    python: [
      "import os",
      "import httpx",
      "",
      'headers = {"Authorization": f"Bearer {os.environ[\'EXPLABS_API_KEY\']}"}',
      "org = os.environ['ORG_ID']",
      `base = "${baseUrl}/api/orgs/" + org + "/provider-connections/openai"`,
      "",
      'httpx.put(base, headers=headers, json={"secret": "sk-...", "config": {}})',
      'print(httpx.post(base + "/check", headers=headers).json()["status"])'
    ].join("\n"),
    javascript: [
      'const headers = { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` };',
      "const org = process.env.ORG_ID;",
      `const base = \`${baseUrl}/api/orgs/\${org}/provider-connections/openai\`;`,
      "",
      "await fetch(base, {",
      '  method: "PUT",',
      '  headers: { ...headers, "Content-Type": "application/json" },',
      '  body: JSON.stringify({ secret: "sk-...", config: {} }),',
      "});",
      'const check = await (await fetch(`${base}/check`, { method: "POST", headers })).json();',
      "console.log(check.status);"
    ].join("\n")
  };
}

function customModelSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl -X POST "${baseUrl}/api/models" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{",
      '    "slug": "my-local-model",',
      '    "display_name": "My Local Model",',
      '    "providers": [{',
      '      "provider": "local",',
      '      "provider_model_id": "my-model",',
      '      "base_url": "https://your-host:8000/v1"',
      "    }]",
      "  }'"
    ].join("\n"),
    python: [
      "import os",
      "import httpx",
      "",
      'headers = {"Authorization": f"Bearer {os.environ[\'EXPLABS_API_KEY\']}"}',
      "httpx.post(",
      `    "${baseUrl}/api/models",`,
      "    headers=headers,",
      "    json={",
      '        "slug": "my-local-model",',
      '        "display_name": "My Local Model",',
      '        "providers": [',
      "            {",
      '                "provider": "local",',
      '                "provider_model_id": "my-model",',
      '                "base_url": "https://your-host:8000/v1",',
      "            }",
      "        ],",
      "    },",
      ")"
    ].join("\n"),
    javascript: [
      'const headers = { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` };',
      "await fetch(`" + baseUrl + "/api/models`, {",
      '  method: "POST",',
      '  headers: { ...headers, "Content-Type": "application/json" },',
      "  body: JSON.stringify({",
      '    slug: "my-local-model",',
      '    display_name: "My Local Model",',
      '    providers: [',
      '      { provider: "local", provider_model_id: "my-model", base_url: "https://your-host:8000/v1" },',
      "    ],",
      "  }),",
      "});"
    ].join("\n")
  };
}
