import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import {
  Callout,
  Code,
  DocsSection,
  DocsTable,
  Prose
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";

export const metadata = { title: "API reference" };

// The public API reference: the /v1 inference surface and the /api management
// surface a customer reaches with an org key. Every route here is admitted for
// customer keys by the allowlist in explabs/api/app.py; platform-admin routes
// are documented separately and only for admins (/docs/internal).

const ENDPOINT_COLUMNS = [
  { key: "endpoint", header: "Endpoint", mono: true },
  { key: "purpose", header: "Purpose" }
] as const;

const INFERENCE_ROWS = [
  {
    endpoint: "GET /v1/models",
    purpose:
      "List the model slugs this key can call; entries add a pricing extension (micro-USD per million tokens)."
  },
  {
    endpoint: "POST /v1/chat/completions",
    purpose: "OpenAI Chat Completions; stream: true for SSE."
  },
  {
    endpoint: "POST /v1/responses",
    purpose: "OpenAI Responses; stream: true for SSE; previous_response_id continues on any worker."
  },
  {
    endpoint: "POST /v1/messages",
    purpose:
      "Anthropic Messages (Claude Code and Anthropic SDKs); x-api-key or Bearer; Anthropic-enveloped errors."
  }
];

const CATALOG_ROWS = [
  { endpoint: "GET /api/models", purpose: "The catalog; filter by modality, category, provider, price, context; sort and page." },
  { endpoint: "GET /api/models/{slug}", purpose: "One model: row, deployments, and default waterfall." },
  { endpoint: "GET /api/models/{slug}/providers", purpose: "A model's deployments." },
  { endpoint: "POST /api/models", purpose: "Create a custom model (row plus at least one deployment)." },
  { endpoint: "POST /api/models/{slug}/providers", purpose: "Add a deployment or local variant to a model." },
  { endpoint: "GET /api/models/{slug}/waterfall", purpose: "Read the default chain and your org override." },
  { endpoint: "PUT /api/models/{slug}/waterfall", purpose: "Replace the ordered chain (model_provider_ids)." }
];

const CONNECTION_ROWS = [
  { endpoint: "GET /api/orgs/{org_id}/provider-connections", purpose: "List your org's provider connections (no secrets)." },
  { endpoint: "PUT /api/orgs/{org_id}/provider-connections/{provider}", purpose: "Connect or rotate a provider key (secret + config)." },
  { endpoint: "POST /api/orgs/{org_id}/provider-connections/{provider}/check", purpose: "Verify a connection." },
  { endpoint: "POST /api/orgs/{org_id}/provider-connections/{provider}/spend-refresh", purpose: "Refresh a provider's reported spend." }
];

const USAGE_ROWS = [
  { endpoint: "GET /api/gateway/usage/daily", purpose: "Grouped usage rollup (group_by day, model, or member)." },
  { endpoint: "GET /api/gateway/usage/events", purpose: "The paginated per-request usage stream." },
  { endpoint: "GET /api/gateway/catalog", purpose: "Aliases as your org resolves them, each with its lane." },
  { endpoint: "GET /api/gateway/keys/{api_key_id}/limits", purpose: "Read a key's effective guardrails, daily spend cap, requests/minute, tokens/minute, with platform defaults included; null means uncapped." },
  { endpoint: "GET /api/keys", purpose: "List your org's API keys (never secrets)." }
];

export default function ReferenceDocsPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Reference"
        title="API reference"
        lede="The OpenAI-compatible inference API and the management API a customer drives with an organization key."
      />

      <DocsSection id="conventions" title="Conventions">
        <Prose>
          Base URL for this deployment is <Code>{baseUrl}</Code>: inference lives
          under <Code>/v1</Code> and management under <Code>/api</Code>. Every call
          authenticates with <Code>Authorization: Bearer &lt;key&gt;</Code>, with
          one exception: the catalog reads (<Code>GET /api/models*</Code>) are
          public and keyless. Without a key you get the public catalog; send your
          key to also see the rows your organization owns. The OpenAI-compatible{" "}
          <Code>GET /v1/models</Code>, by contrast, requires your key.
        </Prose>
        <Callout>
          One org key reaches everything below. It cannot mint or revoke keys
          (that is a web-session action), change another key&apos;s limits, or
          reach platform-admin routes. Writes act for the key&apos;s own
          organization; tenancy scopes every call to it.
        </Callout>
      </DocsSection>

      <DocsSection id="inference" title="Inference (/v1)">
        <Prose>
          The OpenAI-compatible surface. Point any OpenAI client at{" "}
          <Code>{baseUrl}/v1</Code>. See the{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/quickstart">
            Quickstart
          </Link>{" "}
          for runnable calls and{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/errors">
            Errors
          </Link>{" "}
          for the failure envelope.
        </Prose>
        <DocsTable columns={ENDPOINT_COLUMNS} rows={INFERENCE_ROWS} />
      </DocsSection>

      <DocsSection id="catalog" title="Catalog, custom models, and waterfalls (/api)">
        <Prose>
          Read the catalog and manage your org&apos;s custom models and waterfalls.
          See{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/models">
            Models
          </Link>{" "}
          for request and response shapes.
        </Prose>
        <DocsTable columns={ENDPOINT_COLUMNS} rows={CATALOG_ROWS} />
      </DocsSection>

      <DocsSection id="connections" title="Provider connections (/api)">
        <Prose>
          Connect and verify the provider keys that back the pass-through lane.
          Reads never return secret material.
        </Prose>
        <DocsTable columns={ENDPOINT_COLUMNS} rows={CONNECTION_ROWS} />
      </DocsSection>

      <DocsSection id="usage" title="Usage and keys (/api)">
        <Prose>
          Read your own usage and spend and list your keys. Usage reads take{" "}
          <Code>org_id</Code>; an API key reads at <Code>scope=org</Code> (
          <Code>scope=self</Code> needs an end-user session).
        </Prose>
        <DocsTable columns={ENDPOINT_COLUMNS} rows={USAGE_ROWS} />
      </DocsSection>

      <DocsSection id="machine" title="Machine-readable reference">
        <Prose>
          Agents should read{" "}
          <a className="text-ink underline underline-offset-2" href="/llms.txt">
            /llms.txt
          </a>
          , which carries this surface, the error table, and the core loop in one
          plain-text file.
        </Prose>
      </DocsSection>
    </>
  );
}
