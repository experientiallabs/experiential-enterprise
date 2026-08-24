import Link from "next/link";

import { docsApiBaseUrl } from "@/components/docs/base-urls";
import { CodeTabs } from "@/components/docs/CodeTabs";
import {
  Callout,
  Code,
  DocsList,
  DocsSection,
  DocsSubheading,
  DocsTable,
  Prose
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import type { CodeLanguage } from "@/components/docs/code-language";

export const metadata = { title: "Credits & billing" };

// How a call is paid for and how to cap spend. Accurate to the credit model in
// explabs/api/credits.py, the key limits in gateway_admin.py, and the budgets
// and spend alerts in identities.py / spend_alerts.py. Billing controls
// (balance, adding credits, budgets, alerts, auto-recharge) are dashboard
// actions; the one org-key-callable read is a key's effective limits.

const LIMIT_COLUMNS = [
  { key: "field", header: "field", mono: true },
  { key: "meaning", header: "Meaning" }
] as const;

const LIMIT_ROWS = [
  {
    field: "daily_spend_cap_micro_usd",
    meaning: "Max platform-funded spend per day for this key (micro-USD)."
  },
  { field: "requests_per_minute", meaning: "Request-rate ceiling for this key." },
  { field: "tokens_per_minute", meaning: "Token-rate (TPM) ceiling for this key." }
];

export default function BillingDocsPage() {
  const baseUrl = docsApiBaseUrl();
  return (
    <>
      <DocsPageHeader
        eyebrow="Billing & usage"
        title="Credits & billing"
        lede="Every model is paid for through one of two lanes, and the gateway adds no markup on either. Platform-funded calls draw down your credits; bring-your-own-key calls are billed by the provider directly."
      />

      <DocsSection id="lanes" title="Two lanes">
        <DocsList>
          <li>
            <strong className="font-medium text-ink">Platform-funded</strong>: our
            credits, priced from the public catalog. Each call draws down your
            balance and is metered as <Code>cost_micro_usd</Code>.
          </li>
          <li>
            <strong className="font-medium text-ink">Pass-through (BYOK)</strong>:
            your own provider key. The provider bills you directly, so these calls
            never draw credits; they are metered as{" "}
            <Code>estimated_cost_micro_usd</Code> for attribution only.
          </li>
        </DocsList>
        <Prose>
          Which lane a model rides is decided per-provider by its waterfall: a
          deployment backed by one of your{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/models">
            provider connections
          </Link>{" "}
          is pass-through; a platform-seeded deployment is platform-funded. Either
          way, zero markup.
        </Prose>
      </DocsSection>

      <DocsSection id="credits" title="Credits">
        <Prose>
          A new organization starts with a welcome credit grant. Your balance is
          the credit granted minus your billable (platform-funded) spend;
          pass-through usage does not count against it. Balance, spend, adding
          credits, and auto-recharge live in the dashboard at{" "}
          <Link className="text-ink underline underline-offset-2" href="/credits">
            Credits
          </Link>
          .
        </Prose>
        <Callout>
          Balance and top-ups are dashboard (web-session) actions, not API-key
          actions. An agent tracks its own consumption through usage instead: read{" "}
          <Code>GET /api/gateway/usage/daily</Code> for spend by day, model, or
          member. See{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/telemetry">
            Telemetry
          </Link>
          .
        </Callout>
      </DocsSection>

      <DocsSection id="limits" title="Spend controls">
        <Prose>
          Spend is bounded at three levels, all configured in the dashboard:
        </Prose>
        <DocsList>
          <li>
            <strong className="font-medium text-ink">Per-key limits</strong>: a
            daily platform-funded spend cap, a requests-per-minute ceiling, and a
            tokens-per-minute ceiling on each API key.
          </li>
          <li>
            <strong className="font-medium text-ink">Budgets</strong>: a spend
            ceiling scoped to the whole team, an API key, a model, an identity, or
            a routing pool, for a given month or as a recurring cap.
          </li>
          <li>
            <strong className="font-medium text-ink">Spend alerts</strong>: an
            email when monthly org spend or a budget crosses a threshold.
          </li>
        </DocsList>
        <Prose>
          A key can read its own effective limits over the API.{" "}
          <Code>GET /api/gateway/keys/&lt;api_key_id&gt;/limits</Code> returns the
          three ceilings with platform defaults folded in; a <Code>null</Code>{" "}
          value means uncapped, and <Code>source</Code> is <Code>explicit</Code>{" "}
          when set on the key or <Code>default</Code> otherwise. Setting limits is
          an admin dashboard action.
        </Prose>
        <CodeTabs snippets={limitsSnippets(baseUrl)} title="GET /api/gateway/keys/{api_key_id}/limits" />
        <DocsTable columns={LIMIT_COLUMNS} rows={LIMIT_ROWS} />
      </DocsSection>

      <DocsSection id="exhausted" title="When you run out">
        <Prose>
          When your credit balance or a spend limit is exhausted, calls fail with{" "}
          <Code>429 insufficient_quota</Code>; the message says which — a daily org
          or per-model cap, a budget, or your credits. It is not transient:
          retrying does not clear it.
        </Prose>
        <DocsSubheading>How to recover</DocsSubheading>
        <DocsList>
          <li>Add credits or raise a limit in the dashboard (platform-funded lane).</li>
          <li>Or move the model to the pass-through lane by connecting a provider key.</li>
        </DocsList>
        <Prose>
          The full error contract is in{" "}
          <Link className="text-ink underline underline-offset-2" href="/docs/errors">
            Errors
          </Link>
          .
        </Prose>
      </DocsSection>
    </>
  );
}

function limitsSnippets(baseUrl: string): Record<CodeLanguage, string> {
  return {
    curl: [
      `curl "${baseUrl}/api/gateway/keys/$API_KEY_ID/limits" \\`,
      '  -H "Authorization: Bearer $EXPLABS_API_KEY"'
    ].join("\n"),
    python: [
      "import os",
      "import httpx",
      "",
      'headers = {"Authorization": f"Bearer {os.environ[\'EXPLABS_API_KEY\']}"}',
      "resp = httpx.get(",
      `    "${baseUrl}/api/gateway/keys/" + os.environ["API_KEY_ID"] + "/limits",`,
      "    headers=headers,",
      ")",
      "limits = resp.json()",
      'print(limits["daily_spend_cap_micro_usd"], limits["tokens_per_minute"], limits["source"])'
    ].join("\n"),
    javascript: [
      'const headers = { Authorization: `Bearer ${process.env.EXPLABS_API_KEY}` };',
      `const resp = await fetch(\`${baseUrl}/api/gateway/keys/\${process.env.API_KEY_ID}/limits\`, { headers });`,
      "const limits = await resp.json();",
      "console.log(limits.daily_spend_cap_micro_usd, limits.tokens_per_minute, limits.source);"
    ].join("\n")
  };
}
