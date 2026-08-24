"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  BookOpen,
  Coins,
  Cpu,
  Fingerprint,
  Home,
  KeyRound,
  LogIn,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  Sparkles,
  type LucideIcon
} from "lucide-react";
import { clsx } from "clsx";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { BrandMark } from "@/components/brand/BrandMark";
import { Tooltip } from "@/components/ui/Tooltip";
import type { Org } from "@/lib/types";
import {
  adminPath,
  aliasesPath,
  apiKeysPath,
  creditsPath,
  docsPath,
  insightsPath,
  logsPath,
  modelsPath,
  overviewPath,
  settingsPath
} from "@/lib/routes";

import { OrgSwitcher } from "./OrgSwitcher";
import { SidebarCreditAmount } from "./SidebarCreditAmount";
import { SidebarNavItem } from "./SidebarNavItem";
import { SignOutButton } from "./SignOutButton";
import { writeSidebarCollapse } from "./sidebar-collapse";

const ICON_SIZE = 15;

/** Everything the rail renders only for a member; null means signed out. */
export type AppSidebarSession = {
  orgs: Org[];
  currentOrg: Org;
  userEmail: string;
  showAdminPanel: boolean;
};

type AppSidebarProps = {
  session: AppSidebarSession | null;
  /**
   * The cookie-stored collapse preference, read server-side so the rail
   * renders at its remembered width on the first paint. Null means the
   * visitor never chose, which renders expanded.
   */
  initialCollapsed?: boolean | null;
};

type NavEntry = {
  label: string;
  /** One hover-tooltip line saying what the item is, legible from the collapsed rail. */
  description: string;
  icon: LucideIcon;
  href: string;
  activePrefix?: string;
  /** The entry renders for members only (Overview, Admin); every page itself stays public. */
  signedInOnly?: boolean;
};

// The one nav for every visitor (gw-shell P3): the same entries in the same
// order for both audiences, signed-out differing only by the absence of the
// members-only entries. Nothing here ever locks — pages are public and only
// actions gate (useLoginModal) — so no entry may point at /signin or carry a
// padlock state.
const PRIMARY_NAV: NavEntry[] = [
  {
    label: "Overview",
    description: "Your usage, credits, and keys at a glance.",
    icon: Home,
    href: overviewPath(),
    activePrefix: overviewPath(),
    signedInOnly: true
  },
  {
    label: "Models",
    description: "The model catalog, open to explore.",
    icon: Cpu,
    href: modelsPath(),
    activePrefix: modelsPath()
  },
  // Playground is hidden from the sidebar nav (the product owner, 2026-08-20): the page and
  // /playground route stay live and reachable by direct URL — hide-from-nav, not
  // delete, matching the legacy-gate pattern. No nav entry points at it.
  // Always visible, traffic or not (the product owner, 2026-07-30): the page carries its
  // own never-served state, and a nav entry that appears only after the first
  // request hid the surface exactly when a new member was looking for it.
  {
    label: "Logs",
    description: "Every gateway request, per call.",
    icon: Activity,
    href: logsPath(),
    activePrefix: logsPath()
  },
  // Insights sits next to Logs: Logs is the raw per-request table, Insights is
  // the deep usage-analytics dashboard (every graph shown by default) with the
  // natural-language Intelligence query folded in as a tab.
  {
    label: "Insights",
    description: "Usage analytics and intelligence.",
    icon: Sparkles,
    href: insightsPath(),
    activePrefix: insightsPath()
  },
  {
    label: "Docs",
    description: "API reference for calling the gateway.",
    icon: BookOpen,
    href: docsPath(),
    activePrefix: docsPath()
  }
];

const ADMIN_NAV: NavEntry[] = [
  {
    label: "Admin",
    description: "Platform administration.",
    icon: ShieldCheck,
    href: adminPath(),
    activePrefix: adminPath(),
    signedInOnly: true
  }
];

// The bottom cluster (the product owner, D-IA 2026-08-20): API Keys is its own top-level
// entry above Credits, so /api-keys lights ONLY "API Keys" and never Settings
// (the old /settings/api-keys home lit both). Order: Access control / API Keys
// / Credits / Settings. "Access control" (renamed from "Aliases", 2026-08-23)
// names the whole /aliases surface: named aliases plus identities, grants,
// and budgets.
const FOOTER_NAV: NavEntry[] = [
  {
    label: "Access control",
    description: "Model aliases, identities, and the budgets that govern who may call what.",
    icon: Fingerprint,
    href: aliasesPath(),
    activePrefix: aliasesPath(),
    // Admin-managed and workspace-private: the /aliases page is gated, so this
    // never renders for a signed-out visitor.
    signedInOnly: true
  },
  {
    label: "API Keys",
    description: "Keys that authenticate your gateway requests.",
    icon: KeyRound,
    href: apiKeysPath(),
    activePrefix: apiKeysPath(),
    // Account-scoped and workspace-private: the proxy gates /api-keys, so this
    // never renders for a signed-out visitor.
    signedInOnly: true
  },
  {
    label: "Credits",
    description: "Credit balance, history, and top-ups.",
    icon: Coins,
    href: creditsPath(),
    activePrefix: creditsPath()
  },
  {
    label: "Settings",
    description: "Workspace and account settings.",
    icon: Settings,
    // Final IA: the entry points at /settings itself (which lands on the
    // first section, Providers). activePrefix keeps the entry lit on every
    // settings section.
    href: settingsPath(),
    activePrefix: settingsPath()
  }
];

/**
 * The one sidebar for every visitor (gw-shell P3). Signed out it shows the
 * public nav with a Log in button that opens the login modal in place (never
 * a /signin link); signed in it adds the org switcher, Overview, Admin, the
 * credit meter, and the account block. Below 900px the same DOM reflows into
 * a top bar (AGENTS.md fluid-units rule): horizontal nav, account/login at
 * the right edge; the width-collapse control is desktop-only, so the old
 * narrow-viewport auto-collapse heuristic retired with the rail it collapsed.
 */
export function AppSidebar({ session, initialCollapsed = null }: AppSidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed ?? false);
  const { open: openLoginModal } = useLoginModal();

  function toggleCollapsed() {
    setIsCollapsed((value) => {
      const next = !value;
      writeSidebarCollapse(next);
      return next;
    });
  }

  function renderEntries(entries: NavEntry[]) {
    // The hover card only earns its place on the collapsed icon-only rail,
    // where the label is otherwise unreadable (the product owner, gw-r2: hover info ONLY
    // when collapsed). Expanded, the label sits right beside the icon, so the
    // portal Tooltip would just echo it — noise. nativeTitle stays off either
    // way, or the browser's own title bubble would pop beside ours.
    return entries
      .filter((entry) => entry.signedInOnly !== true || session !== null)
      .map(({ label, description, icon: Icon, href, activePrefix }) => {
        const item = (
          <SidebarNavItem
            key={label}
            activePrefix={activePrefix}
            href={href}
            label={label}
            nativeTitle={false}
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <Icon aria-hidden className="shrink-0" size={ICON_SIZE} strokeWidth={1.8} />
              {/* The top bar is icon-only (aria-labels carry the names), so
                  every entry plus the pinned account/login corner fits a
                  phone width without scrolling. */}
              {!isCollapsed && (
                <span className="overflow-hidden text-ellipsis whitespace-nowrap max-[900px]:hidden">
                  {label}
                </span>
              )}
            </span>
            {/* The remaining credit rides the Credits tab it links to,
                right-aligned within the tab via the row's justify-between
                (the product owner: amount to the RIGHT of the label, not the left). The
                standalone meter that once carried it is gone. Icon-only rails
                (collapsed, top bar) drop it with the label. */}
            {!isCollapsed && href === creditsPath() && session !== null && (
              <span className="shrink-0 max-[900px]:hidden">
                {/* Keyed on the org so switching workspaces remounts it: a
                    stale balance never carries over and the welcome bubble
                    re-evaluates for the new org. */}
                <SidebarCreditAmount
                  billableUsd={session.currentOrg.billable_spend_usd}
                  grantedUsd={session.currentOrg.credit_granted_usd}
                  key={session.currentOrg.id}
                  orgSlug={session.currentOrg.slug}
                />
              </span>
            )}
          </SidebarNavItem>
        );
        return isCollapsed ? (
          <Tooltip
            key={label}
            className="w-full max-[900px]:w-auto max-[900px]:shrink-0"
            description={description}
            label={label}
          >
            {item}
          </Tooltip>
        ) : (
          item
        );
      });
  }

  return (
    <aside
      className={clsx(
        "sticky top-0 flex h-dvh min-h-dvh flex-col overflow-hidden border-r border-line bg-background py-[clamp(1rem,3vh,1.25rem)] transition-[width,padding] duration-[160ms] ease-out",
        isCollapsed
          ? "w-[clamp(3.5rem,8vw,4rem)] items-center px-[clamp(0.5rem,1.5vw,0.75rem)]"
          : "w-[clamp(13rem,20vw,15rem)] px-[clamp(0.75rem,1.5vw,1rem)]",
        "max-[900px]:h-auto max-[900px]:min-h-0 max-[900px]:w-full max-[900px]:flex-row max-[900px]:items-center max-[900px]:gap-2 max-[900px]:border-b max-[900px]:border-r-0 max-[900px]:px-[clamp(0.5rem,2vw,1rem)] max-[900px]:py-1.5 max-[900px]:transition-none"
      )}
    >
      <div
        className={clsx(
          "grid items-center gap-2 pb-4",
          isCollapsed ? "justify-items-center" : "grid-cols-[minmax(0,1fr)_30px]",
          "max-[900px]:flex max-[900px]:min-w-0 max-[900px]:max-w-[38vw] max-[900px]:shrink max-[900px]:pb-0"
        )}
      >
        {!isCollapsed &&
          (session !== null ? (
            <OrgSwitcher
              canManageOrgs={session.showAdminPanel}
              currentOrg={session.currentOrg}
              orgs={session.orgs}
            />
          ) : (
            <Link
              aria-label="Experiential home"
              className="inline-flex min-w-0 items-center gap-2 px-2 text-ink"
              href={modelsPath()}
            >
              <BrandMark className="h-5 w-5 shrink-0" />
              {/* Logo only in the top bar; the name costs nav room on a phone. */}
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold max-[900px]:hidden">
                Experiential
              </span>
            </Link>
          ))}
        <button
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="grid h-7 w-7 cursor-pointer place-items-center rounded-[var(--radius-md)] border-0 bg-transparent p-0 text-foreground/30 hover:text-foreground/60 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-line-strong max-[900px]:hidden"
          onClick={toggleCollapsed}
          type="button"
        >
          {isCollapsed ? (
            <PanelLeftOpen aria-hidden size={ICON_SIZE} strokeWidth={1.8} />
          ) : (
            <PanelLeftClose aria-hidden size={ICON_SIZE} strokeWidth={1.8} />
          )}
        </button>
      </div>

      {/* On the top bar this whole group is one horizontal scrollport; only
          the account/login corner is pinned (sticky) at the right edge. */}
      <div className="flex min-h-0 flex-1 flex-col max-[900px]:min-w-0 max-[900px]:flex-row max-[900px]:items-center max-[900px]:gap-1 max-[900px]:overflow-x-auto max-[900px]:overflow-y-hidden max-[900px]:[scrollbar-width:none]">
        <nav
          className={clsx(
            "flex flex-col gap-[1px]",
            isCollapsed && "w-full items-center",
            "max-[900px]:w-auto max-[900px]:shrink-0 max-[900px]:flex-row max-[900px]:items-center"
          )}
        >
          {renderEntries(PRIMARY_NAV)}
        </nav>

        <div
          className={clsx(
            "mt-auto flex flex-col gap-2",
            isCollapsed && "w-full items-center",
            "max-[900px]:ml-auto max-[900px]:mt-0 max-[900px]:w-auto max-[900px]:shrink-0 max-[900px]:flex-row max-[900px]:items-center max-[900px]:gap-1"
          )}
        >
          <nav
            className={clsx(
              "flex w-full flex-col gap-[1px]",
              isCollapsed && "items-center",
              "max-[900px]:w-auto max-[900px]:flex-row max-[900px]:items-center"
            )}
          >
            {session?.showAdminPanel === true && renderEntries(ADMIN_NAV)}
            {renderEntries(FOOTER_NAV)}
          </nav>

          <div
            className={clsx(
              "flex w-full flex-col gap-2 border-t border-line pt-3",
              isCollapsed && "items-center",
              "max-[900px]:sticky max-[900px]:right-0 max-[900px]:z-10 max-[900px]:w-auto max-[900px]:shrink-0 max-[900px]:flex-row max-[900px]:items-center max-[900px]:border-t-0 max-[900px]:bg-background max-[900px]:pl-1 max-[900px]:pt-0"
            )}
          >
            {session !== null ? (
              <SignOutButton userEmail={session.userEmail} isCollapsed={isCollapsed} />
            ) : isCollapsed ? (
              <Tooltip label="Log in" persistent>
                <button
                  aria-label="Log in"
                  className="grid h-7 w-7 cursor-pointer place-items-center rounded-full border border-line-strong bg-surface text-foreground/60 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-line-strong"
                  onClick={openLoginModal}
                  type="button"
                >
                  <LogIn aria-hidden size={13} strokeWidth={1.9} />
                </button>
              </Tooltip>
            ) : (
              <button
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-[7px] text-left text-[13px] font-medium text-foreground/70 transition-colors hover:bg-foreground/[0.02] hover:text-foreground max-[900px]:w-auto"
                onClick={openLoginModal}
                type="button"
              >
                <span
                  aria-hidden
                  className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full border border-line-strong bg-surface"
                >
                  <LogIn size={12} strokeWidth={1.9} />
                </span>
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  Log in
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
