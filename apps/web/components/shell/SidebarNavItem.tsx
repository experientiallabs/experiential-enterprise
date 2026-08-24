"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { clsx } from "clsx";

type SidebarNavItemProps = {
  href: string;
  children: ReactNode;
  activePrefix?: string;
  activePrefixes?: string[];
  label: string;
  /** Onboarding-tour anchor rendered as a data-tour attribute. */
  dataTour?: string;
  /**
   * Set false when a custom Tooltip wraps the item: the browser's native title
   * bubble would pop next to it and the same words would show twice.
   */
  nativeTitle?: boolean;
};

export function SidebarNavItem({
  href,
  children,
  activePrefix,
  activePrefixes,
  label,
  dataTour,
  nativeTitle = true
}: SidebarNavItemProps) {
  const pathname = usePathname();
  const isActive =
    pathname === href ||
    (activePrefix ? pathname.startsWith(activePrefix) : false) ||
    (activePrefixes?.some((prefix) => pathname.startsWith(prefix)) ?? false);

  return (
    <Link
      aria-label={label}
      className={clsx(
        "flex w-full items-center justify-between gap-2.5 rounded-[var(--radius-md)] text-[13px] font-normal min-h-[32px] px-2.5 py-[7px] transition-colors",
        "text-foreground/50 [&_svg]:text-foreground/30",
        isActive
          ? "bg-accent/[0.08] text-accent font-medium [&_svg]:text-accent"
          : "hover:bg-foreground/[0.02] hover:text-foreground/70"
      )}
      data-tour={dataTour}
      href={href}
      title={nativeTitle ? label : undefined}
    >
      {children}
    </Link>
  );
}
