import { OrgApiKeysSection } from "@/components/keys/org-api-keys-section";
import {
  EndpointCard,
  Snippet,
  publicServingBaseUrl
} from "@/components/world-models/endpoint-snippets";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";

export const metadata = { title: "API keys" };

export const dynamic = "force-dynamic";

/**
 * API keys — a first-class top-level page (the product owner, D-IA 2026-08-20): keys are
 * their own surface, one click from anywhere, NOT a Settings tab, so the rail
 * entry lights only "API Keys" and never Settings. Private (account-scoped):
 * main's proxy bounces a signed-out visitor to /signin, so this only ever
 * renders for an authenticated member.
 */
export default async function ApiKeysPage() {
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();

  // Platform admins manage keys everywhere (the same bypass the key routes
  // apply), memberless orgs included. The key list itself loads client-side
  // through the shared KeyHub store over GET /api/keys.
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));

  const baseUrl = publicServingBaseUrl();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-ink text-xl font-semibold">API keys</h1>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
          API keys authenticate your code and the wmo CLI against this organization. Requests
          carry the key as a bearer token.
        </p>
      </div>
      <OrgApiKeysSection canManage={canManage} orgId={org.id} />
      <EndpointCard title="Use your key">
        <div className="flex flex-col gap-3">
          <div>
            <p className="m-0 mb-1 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Base URL
            </p>
            <Snippet text={baseUrl} />
          </div>
          <div>
            <p className="m-0 mb-1 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Verify a key
            </p>
            <Snippet
              text={`curl ${baseUrl}/api/whoami \\\n  -H "Authorization: Bearer $EXPLABS_API_KEY"`}
            />
            <p className="m-0 mt-2 text-muted text-[12px] leading-relaxed">
              The same bearer key authenticates the OpenAI-compatible serving endpoints; the
              copyable /v1/chat/completions snippets live on each model&apos;s page.
            </p>
          </div>
        </div>
      </EndpointCard>
    </div>
  );
}
