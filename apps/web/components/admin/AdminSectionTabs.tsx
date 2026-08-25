"use client";

import { usePathname } from "next/navigation";

import { SlidingTabs } from "@/components/ui/SlidingTabs";
import {
  adminAccessPath,
  adminEnterprisePath,
  adminExperientialCloudPath,
  adminPath,
  adminPlatformPath,
  adminPromotionsPath,
  adminTelemetryPath,
  adminUsersPath
} from "@/lib/routes";

/**
 * The admin panel's section switcher (the product owner, 2026-08-01: sections you click
 * into instead of one long scroll). Route tabs mounted in the admin layout so
 * they survive section swaps; a client component because the active section
 * is the pathname, which a layout does not receive on the server. New admin
 * surfaces join here as one more entry.
 */
export function AdminSectionTabs() {
  const pathname = usePathname();
  const tabs = [
    { key: "organizations", label: "Organizations", href: adminPath(), exact: true },
    { key: "users", label: "Users", href: adminUsersPath(), exact: false },
    { key: "telemetry", label: "Telemetry", href: adminTelemetryPath(), exact: false },
    { key: "access", label: "Access", href: adminAccessPath(), exact: false },
    { key: "platform", label: "Platform", href: adminPlatformPath(), exact: false },
    { key: "promotions", label: "Promotions", href: adminPromotionsPath(), exact: false },
    { key: "enterprise", label: "Enterprise", href: adminEnterprisePath(), exact: false },
    {
      key: "experiential-cloud",
      label: "Experiential Cloud",
      href: adminExperientialCloudPath(),
      exact: false
    }
  ];
  const active = tabs.find(({ href, exact }) =>
    exact ? pathname === href : pathname.startsWith(href)
  );
  return (
    <SlidingTabs
      activeKey={active?.key ?? "organizations"}
      ariaLabel="Admin sections"
      tabs={tabs.map(({ key, label, href }) => ({ key, label, href }))}
    />
  );
}
