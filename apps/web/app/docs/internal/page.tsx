import { notFound } from "next/navigation";

import {
  Callout,
  Code,
  DocsSection,
  DocsTable,
  Prose
} from "@/components/docs/DocsContent";
import { DocsPageHeader } from "@/components/docs/DocsPageHeader";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { isPlatformAdmin } from "@/lib/auth/admin";

export const metadata = { title: "Internal reference" };

// The admin-only internal API reference. Gated exactly like the /admin control
// plane: it renders as not-found for everyone who is not a platform operator,
// so neither the navigation (it is absent from docs-nav and the search index)
// nor a guessed URL reveals it. These routes require a platform-admin actor and
// are not admitted for customer API keys by the allowlist in
// explabs/api/app.py.

const ENDPOINT_COLUMNS = [
  { key: "endpoint", header: "Endpoint", mono: true },
  { key: "purpose", header: "Purpose" }
] as const;

const FLEET_ROWS = [
  { endpoint: "GET /api/gateway/workers", purpose: "The gateway worker fleet with heartbeat freshness (platform admin)." },
  { endpoint: "PUT /api/gateway/keys/{api_key_id}/limits", purpose: "Replace a key's guardrails, daily spend cap, requests/minute, tokens/minute; null means uncapped (org admin, management plane; not an API-key action)." }
];

const ORG_ROWS = [
  { endpoint: "GET /api/orgs/usage", purpose: "Cross-org usage." },
  { endpoint: "POST /api/admin/orgs", purpose: "Administer organizations." },
  { endpoint: "DELETE /api/admin/orgs/{orgId}", purpose: "Remove an organization." },
  { endpoint: "POST /api/admin/orgs/{orgId}/credit-grants", purpose: "Issue a credit grant." },
  { endpoint: "PUT /api/admin/orgs/{orgId}/free-credit-caps", purpose: "Lift or set the org's caps (the manual cap-lift override)." },
  { endpoint: "POST /api/admin/orgs/{orgId}/members", purpose: "Add a member; PATCH/DELETE .../members/{userId} to change a role or remove." },
  { endpoint: "GET /api/admin/serving-requests/{requestId}", purpose: "Inspect one request for support." }
];

const ENTITLEMENT_ROWS = [
  {
    endpoint: "GET /api/admin/entitlements",
    purpose: "Every enterprise grant on the deployment, labeled with its org (the Enterprise tab's read; expired rows included)."
  },
  {
    endpoint: "GET /api/admin/orgs/{orgId}/entitlements",
    purpose: "One org's grants, expired rows included."
  },
  {
    endpoint: "PUT /api/admin/orgs/{orgId}/entitlements/{capability}",
    purpose: "Grant (or re-grant with new terms) one capability. Body: optional note (<=512 chars) and expires_at (ISO 8601 with offset, must be future) for time-bound pilots."
  },
  {
    endpoint: "DELETE /api/admin/orgs/{orgId}/entitlements/{capability}",
    purpose: "Revoke one grant; the org's feature surface goes absent within ~30s on warm pods."
  }
];

const GRANT_CURL = [
  "curl -X PUT https://api.experientiallabs.ai/api/admin/orgs/$ORG_ID/entitlements/teams \\",
  '  -H "Authorization: Bearer $SUPERADMIN_KEY" \\',
  '  -H "content-type: application/json" \\',
  `  -d '{"note": "Acme pilot", "expires_at": "2026-12-01T00:00:00+00:00"}'`
].join("\n");

const REVOKE_CURL = [
  "curl -X DELETE https://api.experientiallabs.ai/api/admin/orgs/$ORG_ID/entitlements/teams \\",
  '  -H "Authorization: Bearer $SUPERADMIN_KEY"'
].join("\n");

const USER_ROWS = [
  { endpoint: "PUT/DELETE /api/admin/users/{userId}/site-admin", purpose: "Grant or revoke platform-admin." },
  { endpoint: "POST /api/admin/invites", purpose: "Create an invite; DELETE /api/admin/invites/{inviteId} to revoke." },
  { endpoint: "POST /api/admin/invitations", purpose: "Create an invitation; DELETE /api/admin/invitations/{invitationId} to revoke." }
];

export default async function InternalDocsPage() {
  if (!(await isPlatformAdmin())) {
    notFound();
  }
  return (
    <>
      <DocsPageHeader
        eyebrow="Reference"
        title="Internal reference"
        lede="Platform-admin operations that back the control plane. Visible only to Experiential operators; these routes reject customer API keys."
      />

      <Callout tone="warning">
        This page is not linked from the sidebar or the search index and returns
        not-found for anyone who is not a platform admin. The routes below require
        a platform-admin session and are not on the customer-key allowlist. Do not
        reference them in customer-facing material.
      </Callout>

      <DocsSection id="fleet" title="Gateway fleet and key limits">
        <Prose>
          Operator reads over the canonical gateway tables, plus the one direct
          write the control API owns on gateway state.
        </Prose>
        <DocsTable columns={ENDPOINT_COLUMNS} rows={FLEET_ROWS} />
        <Prose>
          Platform admins may also manage the public catalog through the ordinary
          catalog routes by passing <Code>org_id: null</Code>: a{" "}
          <Code>POST /api/models</Code> or{" "}
          <Code>PUT /api/models/{"{slug}"}/waterfall</Code> with a null org writes
          the public row or the default chain that every tenant inherits.
        </Prose>
      </DocsSection>

      <DocsSection id="orgs" title="Organizations and credits">
        <Prose>
          The admin Orgs panel is backed by these routes, including the manual
          caps-lifted override (launch default is caps until first paid top-up).
        </Prose>
        <DocsTable columns={ENDPOINT_COLUMNS} rows={ORG_ROWS} />
      </DocsSection>

      <DocsSection id="users" title="Users and access">
        <DocsTable columns={ENDPOINT_COLUMNS} rows={USER_ROWS} />
      </DocsSection>

      <DocsSection id="entitlements" title="Enterprise entitlements">
        <Prose>
          The hosted tier of the enterprise capability registry: a grant licenses ONE
          organization for one feature. Without a grant (and without the self-host instance
          license, <Code>EXPLABS_EE_CAPABILITIES</Code>), the feature is absent from that
          org&apos;s product — settings entries do not render and the routes answer 404. The
          capability keys are <Code>audit_log</Code>, <Code>sso</Code>, <Code>scim</Code>,{" "}
          <Code>teams</Code>, and <Code>data_controls</Code>. Every grant and revoke is
          written to the org&apos;s audit log (<Code>entitlements.grant</Code> /{" "}
          <Code>entitlements.revoke</Code>). The admin panel&apos;s Enterprise tab drives
          these same routes.
        </Prose>
        <DocsTable columns={ENDPOINT_COLUMNS} rows={ENTITLEMENT_ROWS} />
        <Prose>
          All four accept a platform-admin session or a superadmin key (the machine lane —
          superadmin keys authenticate as their operator with platform-admin authority, and
          any actor header they send is ignored). Granting a capability with the API:
        </Prose>
        <CodeBlock
          code={GRANT_CURL}
          language="bash"
          title="Grant a capability (superadmin key)"
        />
        <Prose>
          Omit <Code>expires_at</Code> for an open-ended grant. A second PUT re-grants with the
          new terms (one row per org and capability). Revoking:
        </Prose>
        <CodeBlock code={REVOKE_CURL} language="bash" title="Revoke a capability" />
        <Callout tone="warning">
          Do not confuse this with the self-host lane: licensed self-hosted installs (and the
          enterprise trial) enable features install-wide with the{" "}
          <Code>EXPLABS_EE_CAPABILITIES</Code> environment variable. Rows here are only for
          organizations on the hosted platform.
        </Callout>
      </DocsSection>
    </>
  );
}
