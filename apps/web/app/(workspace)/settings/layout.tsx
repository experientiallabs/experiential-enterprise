import type { ReactNode } from "react";

import { SettingsNav } from "@/components/settings/SettingsNav";
import { resolveActiveOrgForTelemetry } from "@/lib/active-org";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { getOrgCapabilities } from "@/lib/capabilities";

export const dynamic = "force-dynamic";

/**
 * The consolidated settings surface: API keys, providers, observability,
 * members, organization, and account live as sections under one header
 * (gw-shell P9; billing moved out to /credits). The frame renders for every
 * audience — signed-out, each section shows the shared locked card instead
 * of content, so this layout must not fetch account data itself.
 *
 * The one thing it resolves is the enterprise capability map for the nav:
 * an unlicensed capability means its entry (Domains & SSO, Audit log,
 * Teams) is ABSENT — no
 * lock icon, no upsell (docs/enterprise.md §1). The resolution is fail-soft
 * on purpose: signed-out or org-less sessions read as hidden through the
 * tolerant org resolver, and a registry error hides the entries — never a
 * redirect or a failed render.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const user = await getAuthenticatedUser();
  const org = user === null ? null : await resolveActiveOrgForTelemetry();
  const capabilities = org === null ? null : await getOrgCapabilities(org.id);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-ink text-xl font-semibold">Settings</h1>
      </div>
      <SettingsNav
        showAuditLog={capabilities?.audit_log === "available"}
        showDataControls={capabilities?.data_controls === "available"}
        showScim={capabilities?.scim === "available"}
        showSso={capabilities?.sso === "available"}
        showTeams={capabilities?.teams === "available"}
      />
      {children}
    </div>
  );
}
