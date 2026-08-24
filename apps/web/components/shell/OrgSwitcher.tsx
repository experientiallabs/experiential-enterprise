"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ChevronDown, LayoutGrid, Plus } from "lucide-react";
import { clsx } from "clsx";

import type { Org } from "@/lib/types";
import { modelsPath, orgsPath } from "@/lib/routes";

type OrgSwitcherProps = {
  orgs: Org[];
  currentOrg: Org;
  /**
   * Platform operators (the product owner, 2026-08-01): creating organizations stays an
   * operator move, and operators always get the menu regardless of their own
   * membership count. Switching, however, is for ANY member of more than one
   * org (enterprise build-out): a multi-org member gets the same menu over
   * their own memberships, just without the create entry. A single-org member
   * still sees their org's name as a plain label, no menu.
   */
  canManageOrgs: boolean;
};

export function OrgSwitcher({ orgs, currentOrg, canManageOrgs }: OrgSwitcherProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  /** The org whose cookie write is in flight; renders dimmed on the trigger. */
  const [pendingOrg, setPendingOrg] = useState<Org | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);

  // Switching soft-navigates and refreshes but leaves the sidebar (and this
  // switcher) mounted, so `pendingOrg` stays latched after the switch lands.
  // The early-return guard in switchOrg then treats the switcher as forever
  // busy and swallows every later click — you could switch once and then never
  // again, including back to the org you came from (the product owner, 2026-08-21). Release
  // the latch as soon as the active org changes.
  useEffect(() => {
    setPendingOrg(null);
  }, [currentOrg.id]);

  // The sidebar is overflow-hidden (it animates its width), so the menu renders
  // through a portal with fixed positioning instead of being clipped by it.
  useLayoutEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPosition({ top: rect.bottom + 6, left: rect.left - 2 });
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }
    // Keep the fixed-position menu aligned to the trigger without dismissing it:
    // scrolling the page (or resizing) should move the menu with its button, not
    // close it — only select, outside-click, and Escape close the menu.
    function reposition() {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setMenuPosition({ top: rect.bottom + 6, left: rect.left - 2 });
      }
    }
    function onScroll(event: Event) {
      // Scrolling inside the menu itself must not move or close it.
      const target = event.target;
      if (target instanceof Node && menuRef.current && menuRef.current.contains(target)) {
        return;
      }
      reposition();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [isOpen]);

  function navigate(path: string) {
    setIsOpen(false);
    router.push(path);
  }

  // Switching org = writing the active-org cookie, then landing on the
  // workspace root; URLs do not carry the org. The cookie write must land
  // before navigation, so the trigger shows the target org dimmed while it is
  // in flight; without that the click reads as ignored on a slow connection.
  async function switchOrg(org: Org) {
    if (pendingOrg !== null) {
      return;
    }
    setIsOpen(false);
    setPendingOrg(org);
    const response = await fetch("/api/active-org", {
      body: JSON.stringify({ org: org.slug }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    // Navigating without the cookie write would silently land in the OLD org;
    // staying put is the lesser surprise.
    if (!response.ok) {
      setPendingOrg(null);
      return;
    }
    router.push(modelsPath());
    router.refresh();
    // Re-selecting the already-active org re-renders with the SAME currentOrg
    // id, so the clearing effect above never fires; release the latch here so
    // the switcher does not wedge on a same-org selection.
    if (org.id === currentOrg.id) {
      setPendingOrg(null);
    }
  }

  // The menu opens for operators and for anyone who belongs to more than one
  // org; a single-org member has nothing to switch to.
  const interactive = canManageOrgs || orgs.length > 1;

  if (!interactive) {
    return (
      <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 items-center px-2">
        <div className="grid w-5 h-5 place-items-center rounded-[5px] bg-foreground text-white text-[10px] font-bold">
          {currentOrg.name.charAt(0)}
        </div>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap px-1 py-[3px] text-sm font-semibold leading-tight text-foreground">
          {currentOrg.name}
        </span>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 items-center px-2">
      <div className="grid w-5 h-5 place-items-center rounded-[5px] bg-foreground text-white text-[10px] font-bold">
        {currentOrg.name.charAt(0)}
      </div>
      <div className="relative min-w-0">
        <button
          ref={buttonRef}
          aria-busy={pendingOrg !== null}
          aria-label="Switch organization"
          aria-expanded={isOpen}
          className="grid w-full grid-cols-[minmax(0,1fr)_14px] gap-[5px] items-center min-w-0 border-0 rounded-[var(--radius-sm)] bg-transparent text-foreground cursor-pointer text-sm font-semibold leading-tight outline-0 px-1 py-[3px] text-left hover:bg-hover focus-visible:bg-hover"
          onClick={() => setIsOpen((value) => !value)}
          type="button"
        >
          {/* Mid-switch the trigger pre-announces the destination, dimmed. */}
          <span
            className={clsx(
              "overflow-hidden text-ellipsis whitespace-nowrap",
              pendingOrg !== null && "opacity-50"
            )}
          >
            {(pendingOrg ?? currentOrg).name}
          </span>
          <ChevronDown aria-hidden size={13} className="text-muted-2" strokeWidth={1.8} />
        </button>
        {isOpen && menuPosition !== null
          ? createPortal(
              <div
                ref={menuRef}
                className="fixed z-50 min-w-[218px] max-w-[280px] border border-line-strong rounded-[var(--radius-lg)] bg-white shadow-[0_6px_16px_rgba(20,20,18,0.08)] p-1"
                role="menu"
                style={{ top: menuPosition.top, left: menuPosition.left }}
              >
                {orgs.map((org) => (
                  <button
                    className={clsx(
                      "grid w-full gap-[3px] border-0 rounded-[var(--radius-sm)] bg-transparent text-[#2d2d2d] cursor-pointer text-[13px] font-medium px-[9px] py-2 text-left hover:bg-active",
                      org.id === currentOrg.id && "bg-active"
                    )}
                    key={org.id}
                    onClick={() => void switchOrg(org)}
                    role="menuitem"
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                        {org.name}
                      </span>
                      {/* The membership-discovery carve-out's tag (E2): an
                          sso_required org stays findable here so a member can
                          initiate step-up; everything else is gated. */}
                      {org.sso_required ? (
                        <span className="shrink-0 rounded border border-line-strong px-1 py-px text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-2">
                          SSO
                        </span>
                      ) : null}
                    </span>
                    <span className="text-muted-2 text-[11px] font-[460] overflow-hidden text-ellipsis whitespace-nowrap">
                      {org.slug}
                    </span>
                  </button>
                ))}
                <div className="my-1 border-t border-line" />
                <button
                  className="flex w-full items-center gap-2 border-0 rounded-[var(--radius-sm)] bg-transparent text-[#2d2d2d] cursor-pointer text-[13px] font-medium px-[9px] py-2 text-left hover:bg-active"
                  onClick={() => navigate(orgsPath())}
                  role="menuitem"
                  type="button"
                >
                  <LayoutGrid aria-hidden size={13} className="text-muted-2" strokeWidth={1.8} />
                  <span>All organizations</span>
                </button>
                {/* Creation is operator-only; a multi-org member's menu ends
                    at the grid of their own organizations. */}
                {canManageOrgs && (
                  <button
                    className="flex w-full items-center gap-2 border-0 rounded-[var(--radius-sm)] bg-transparent text-[#2d2d2d] cursor-pointer text-[13px] font-medium px-[9px] py-2 text-left hover:bg-active"
                    onClick={() => navigate(`${orgsPath()}?create=1`)}
                    role="menuitem"
                    type="button"
                  >
                    <Plus aria-hidden size={13} className="text-muted-2" strokeWidth={1.8} />
                    <span>New organization</span>
                  </button>
                )}
              </div>,
              document.body
            )
          : null}
      </div>
    </div>
  );
}
