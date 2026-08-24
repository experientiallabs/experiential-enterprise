"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

import {
  accountSettingsPath,
  auditSettingsPath,
  connectionsSettingsPath,
  dataControlsSettingsPath,
  membersSettingsPath,
  organizationSettingsPath,
  scimSettingsPath,
  ssoSettingsPath,
  teamsSettingsPath
} from "@/lib/routes";

/** The settings surface's section switcher; each section is a route. */
export function SettingsNav({
  showAuditLog,
  showDataControls,
  showScim,
  showSso,
  showTeams
}: {
  showAuditLog: boolean;
  showDataControls: boolean;
  showScim: boolean;
  showSso: boolean;
  showTeams: boolean;
}) {
  const pathname = usePathname();
  // Final IA (credits/settings redesign 2026-08-22): four core sections.
  // Providers and Observability merged into Connections; Identities & access
  // moved out to the top-level Access control page (/aliases); API keys,
  // aliases, and credits are all first-class top-level pages, so none of them
  // is a section here.
  //
  // Enterprise gates (/ee): without its capability an entry is ABSENT — no
  // lock icon, no upsell. The server layout threads the flags because this
  // client component cannot resolve them itself.
  const sections = [
    { label: "Connections", href: connectionsSettingsPath() },
    { label: "Members", href: membersSettingsPath() },
    ...(showTeams ? [{ label: "Teams", href: teamsSettingsPath() }] : []),
    { label: "Organization", href: organizationSettingsPath() },
    ...(showSso ? [{ label: "Domains & SSO", href: ssoSettingsPath() }] : []),
    ...(showScim ? [{ label: "SCIM provisioning", href: scimSettingsPath() }] : []),
    ...(showDataControls
      ? [{ label: "Provider policy", href: dataControlsSettingsPath() }]
      : []),
    ...(showAuditLog ? [{ label: "Audit log", href: auditSettingsPath() }] : []),
    { label: "Account", href: accountSettingsPath() }
  ];
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-1 border-b border-line">
      {sections.map((section) => {
        const isActive = pathname.startsWith(section.href);
        return (
          <Link
            key={section.href}
            aria-current={isActive ? "page" : undefined}
            className={clsx(
              "-mb-px border-b-2 px-2.5 pb-2 pt-1 text-[13px] transition-colors",
              isActive
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-foreground/50 hover:text-foreground/75"
            )}
            href={section.href}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
