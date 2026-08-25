import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeTabs } from "@/components/docs/CodeTabs";
import {
  Callout,
  Code,
  DocsSection,
  DocsSubheading,
  DocsTable,
  Prose
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import type { CodeLanguage } from "@/components/docs/code-language";

export const metadata = { title: "Telemetry" };

// Read gateway usage and spend over the API, and bring external traces in as
// telemetry. Accurate to the usage reads in explabs/api/routes/gateway_admin.py
// and the telemetry ingest routes; every path here is admitted for customer
// keys and acts for the key's own organization.

const GROUP_COLUMNS = [
  { key: "group", header: "group_by", mono: true },
  { key: "row", header: "One row per" }
] as const;

const GROUP_ROWS = [
  { group: "day", row: "Calendar day (the row carries day)." },
  { group: "day_model", row: "Calendar day and model (the row carries day and alias)." },
  { group: "model", row: "Model slug (the row carries alias)." },
  { group: "member", row: "Org member or end user (the row carries user_id)." }
];

export default function TelemetryDocsPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Billing & usage"
        title="Telemetry"
        lede="Every call through the gateway is metered. Read your usage and spend over the API with the same org key, or bring traces from your existing stack in as telemetry."
      />

      <DocsSection id="daily" title="Usage rollups">
        <Prose>
          <Code>GET /api/gateway/usage/daily</Code> returns a grouped rollup of
          requests, tokens, and spend. Pass <Code>org_id</Code> and{" "}
          <Code>group_by</Code>; an API key reads at <Code>scope=org</Code> (
          <Code>scope=self</Code> needs an end-user session). Spend is reported in{" "}
          <Code>spend_micro_usd</Code> (millionths of a US dollar).
        </Prose>
        <CodeTabs snippets={dailySnippets(baseUrl)} title="GET /api/gateway/usage/daily" />
        <DocsTable columns={GROUP_COLUMNS} rows={GROUP_ROWS} />
      </DocsSection>

      <DocsSection id="events" title="Per-request events">
        <Prose>
          <Code>GET /api/gateway/usage/events</Code> is the paginated per-request
          stream behind the rollup: one row per call, with its model, lane,
          tokens, and spend. Use it to attribute cost to a specific request or to
          export raw usage.
        </Prose>
        <CodeTabs snippets={eventsSnippets(baseUrl)} title="GET /api/gateway/usage/events" />
        <Callout>
          Mint one key per agent or workload so <Code>group_by=member</Code> and
          the event stream break spend out per caller. Humans see the same data
          at{" "}
          <Link className="text-ink underline underline-offset-2" href="/telemetry">
            Telemetry
          </Link>{" "}
          and{" "}
          <Link className="text-ink underline underline-offset-2" href="/credits">
            Credits
          </Link>
          .
        </Callout>
      </DocsSection>

      <DocsSection id="traces" title="Bring your own traces">
        <Prose>
          Beyond gateway metering, you can land traces from your existing
          observability stack as telemetry. This never builds a router or spends
          credits; it just stores the traces under your organization.
        </Prose>
        <DocsSubheading>Live pull from a provider</DocsSubheading>
        <Prose>
          <Code>POST /api/orgs/&lt;org_id&gt;/telemetry/traces/pull</Code> pulls
          from a provider you name in <Code>transport_kind</Code> (one of{" "}
          <Code>braintrust</Code>, <Code>langsmith</Code>, <Code>langfuse</Code>,{" "}
          <Code>posthog</Code>, <Code>mastra</Code>, <Code>postgres</Code>). The{" "}
          <Code>credential</Code> is a single string, used once and never stored
          on the row: for Langfuse it is the{" "}
          <Code>public_key:secret_key</Code> pair; for the token-based providers
          it is the API key; for <Code>postgres</Code> it is the connection
          string.
        </Prose>
        <CodeTabs snippets={pullSnippets(baseUrl)} title="POST /api/orgs/{org_id}/telemetry/traces/pull" />
        <DocsSubheading>Upload a file</DocsSubheading>
        <Prose>
          <Code>POST /api/orgs/&lt;org_id&gt;/telemetry/traces/upload</Code>{" "}
          reserves an ingest-scoped Storage path after authenticating the{" "}
          <Code>xpl_</Code> key. The body is JSON{" "}
          <Code>{`{source_kind, source_label}`}</Code> (one of{" "}
          <Code>otel-genai</Code>, <Code>otlp</Code>, <Code>langfuse</Code>,{" "}
          <Code>langsmith</Code>, <Code>phoenix</Code>, <Code>braintrust</Code>,{" "}
          <Code>mastra</Code>, <Code>posthog</Code>, <Code>chat-json</Code>). The
          response is a two-hour, path-bound signed upload URL and token, never
          service credentials. PUT the exact raw file bytes to{" "}
          <Code>signed_url</Code>, then{" "}
          <Code>POST /api/orgs/&lt;org_id&gt;/telemetry/traces/&lt;ingest_id&gt;/finalize</Code>{" "}
          to enqueue verification. Finalize returns 202 quickly; the worker
          checks existence, the 50MB limit, format, exact size, and SHA-256
          before projecting. Arize and Phoenix have no live pull yet, so upload
          them with <Code>source_kind=phoenix</Code> (or <Code>otlp</Code>).
        </Prose>
        <CodeTabs snippets={uploadSnippets(baseUrl)} title="POST /api/orgs/{org_id}/telemetry/traces/upload" />
        <Prose>
          <Code>GET /api/orgs/&lt;org_id&gt;/telemetry/traces</Code> lists the
          org&apos;s landed traces with <Code>total_ingests</Code> and{" "}
          <Code>total_traces</Code>, the verify count.
        </Prose>
      </DocsSection>

      <DocsSection id="more" title="See also">
        <Prose>
          How each call is paid for and how to cap spend is in{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/billing">
            Credits &amp; billing
          </Link>
          , and every usage endpoint is in the{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/reference">
            API reference
          </Link>
          .
        </Prose>
      </DocsSection>
    </>
  );
}

function dailySnippets(baseUrl: string): Record<CodeLanguage, string> {
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

function eventsSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl "${baseUrl}/api/gateway/usage/events?org_id=$ORG_ID&limit=50" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY"'
    ].join("\n"),
    python: [
      "import os",
      "import httpx",
      "",
      'headers = {"Authorization": f"Bearer {os.environ[\'EXPLABS_API_KEY\']}"}',
      "resp = httpx.get(",
      `    "${baseUrl}/api/gateway/usage/events",`,
      '    params={"org_id": os.environ["ORG_ID"], "limit": 50},',
      "    headers=headers,",
      ")",
      "body = resp.json()",
      'for event in body["events"]:',
      '    print(event["alias"], event["lane"], event["cost_micro_usd"])',
      'print("next_cursor:", body["next_cursor"])'
    ].join("\n"),
    javascript: [
      'const headers = { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` };',
      "const params = new URLSearchParams({ org_id: process.env.ORG_ID, limit: \"50\" });",
      `const resp = await fetch(\`${baseUrl}/api/gateway/usage/events?\${params}\`, { headers });`,
      "const { events, next_cursor } = await resp.json();",
      "for (const event of events) console.log(event.alias, event.lane, event.cost_micro_usd);",
      "console.log(\"next_cursor:\", next_cursor);"
    ].join("\n")
  };
}

function pullSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl -X POST "${baseUrl}/api/orgs/$ORG_ID/telemetry/traces/pull" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{",
      '    "transport_kind": "langfuse",',
      '    "source_kind": "langfuse",',
      '    "source_label": "prod",',
      '    "credential": "pk-lf-...:sk-lf-..."',
      "  }'"
    ].join("\n"),
    python: [
      "import os",
      "import httpx",
      "",
      'headers = {"Authorization": f"Bearer {os.environ[\'EXPLABS_API_KEY\']}"}',
      "httpx.post(",
      `    "${baseUrl}/api/orgs/" + os.environ["ORG_ID"] + "/telemetry/traces/pull",`,
      "    headers=headers,",
      "    json={",
      '        "transport_kind": "langfuse",',
      '        "source_kind": "langfuse",',
      '        "source_label": "prod",',
      '        "credential": "pk-lf-...:sk-lf-...",',
      "    },",
      ")"
    ].join("\n"),
    javascript: [
      'const headers = { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` };',
      "await fetch(`" + baseUrl + "/api/orgs/${process.env.ORG_ID}/telemetry/traces/pull`, {",
      '  method: "POST",',
      '  headers: { ...headers, "Content-Type": "application/json" },',
      "  body: JSON.stringify({",
      '    transport_kind: "langfuse",',
      '    source_kind: "langfuse",',
      '    source_label: "prod",',
      '    credential: "pk-lf-...:sk-lf-...",',
      "  }),",
      "});"
    ].join("\n")
  };
}

function uploadSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `TICKET=$(curl -sS -X POST "${baseUrl}/api/orgs/$ORG_ID/telemetry/traces/upload" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"source_kind":"otlp","source_label":"prod-otel-august"}\')',
      'curl -sS -X PUT "$(echo "$TICKET" | jq -r .signed_url)" \\',
      '  -H "Content-Type: application/octet-stream" \\',
      "  --data-binary @traces.jsonl",
      `curl -sS -X POST "${baseUrl}/api/orgs/$ORG_ID/telemetry/traces/$(echo "$TICKET" | jq -r .ingest_id)/finalize" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY"'
    ].join("\n"),
    python: [
      "import os",
      "from pathlib import Path",
      "",
      "import httpx",
      "",
      "from explabs.trace_acquisition.formats import TraceUploadFormat",
      "from explabs.trace_acquisition.telemetry_upload_client import TelemetryTraceUploadClient",
      "",
      "with httpx.Client() as http:",
      "    accepted = TelemetryTraceUploadClient(",
      "        http,",
      `        api_base_url="${baseUrl}",`,
      '        api_key=os.environ["EXPLABS_API_KEY"],',
      "    ).upload(",
      '        org_id=os.environ["ORG_ID"],',
      "        source_kind=TraceUploadFormat.OTLP,",
      '        source_label="prod-otel-august",',
      '        content=Path("traces.jsonl").read_bytes(),',
      "    )",
      "print(accepted.ingest_id, accepted.status)"
    ].join("\n"),
    javascript: [
      'const headers = { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` };',
      "const created = await fetch(",
      `  \`${baseUrl}/api/orgs/\${process.env.ORG_ID}/telemetry/traces/upload\`,`,
      "  {",
      '    method: "POST",',
      '    headers: { ...headers, "Content-Type": "application/json" },',
      '    body: JSON.stringify({ source_kind: "otlp", source_label: "prod-otel-august" }),',
      "  }",
      ");",
      "const ticket = await created.json();",
      "await fetch(ticket.signed_url, {",
      '  method: "PUT",',
      '  headers: { "Content-Type": "application/octet-stream" },',
      "  body: fileBytes,",
      "});",
      "await fetch(",
      `  \`${baseUrl}/api/orgs/\${process.env.ORG_ID}/telemetry/traces/\${ticket.ingest_id}/finalize\`,`,
      '  { method: "POST", headers }',
      ");"
    ].join("\n")
  };
}
