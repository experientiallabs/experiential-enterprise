"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { DOCS_NAV, DOCS_PAGES } from "@/components/docs/docs-nav";

// The grouped docs nav. Rendered twice by DocsShell: as the fixed left rail on
// desktop and as a horizontal scroll strip on small viewports (`horizontal`).

export function DocsSidebar({ horizontal = false }: { horizontal?: boolean }) {
  const pathname = usePathname();
  if (horizontal) {
    return (
      <nav
        aria-label="Documentation"
        className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-line px-3 py-2 lg:hidden"
      >
        {DOCS_PAGES.map((entry) => (
          <Link
            key={entry.path}
            aria-current={pathname === entry.path ? "page" : undefined}
            className={clsx(
              "whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12.5px]",
              pathname === entry.path
                ? "bg-accent-soft font-medium text-accent"
                : "text-muted hover:text-ink"
            )}
            href={entry.path}
          >
            {entry.title}
          </Link>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label="Documentation" className="flex flex-col gap-6">
      {DOCS_NAV.map((group) => (
        <div key={group.label}>
          <p className="mono-label m-0 mb-2">{group.label}</p>
          <ul className="m-0 flex list-none flex-col gap-px p-0">
            {group.entries.map((entry) => (
              <li key={entry.path}>
                <Link
                  aria-current={pathname === entry.path ? "page" : undefined}
                  className={clsx(
                    "block rounded-md px-2.5 py-1.5 text-[13px] leading-snug",
                    pathname === entry.path
                      ? "bg-accent-soft font-medium text-accent"
                      : "text-muted hover:bg-hover hover:text-ink"
                  )}
                  href={entry.path}
                >
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
