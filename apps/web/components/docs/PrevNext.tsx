"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { docsPrevNext } from "@/components/docs/docs-nav";

// Reading-order footer links, derived from the same nav order as the sidebar.

export function PrevNext() {
  const pathname = usePathname();
  const { prev, next } = docsPrevNext(pathname);
  if (prev === null && next === null) {
    return null;
  }
  return (
    <div className="mt-12 flex items-stretch justify-between gap-3 border-t border-line pt-5">
      {prev ? (
        <Link
          className="group flex flex-col gap-1 rounded-md border border-line bg-surface px-3.5 py-2.5 hover:border-line-strong"
          href={prev.path}
        >
          <span className="mono-label flex items-center gap-1">
            <ArrowLeft size={11} strokeWidth={1.8} />
            Previous
          </span>
          <span className="text-[13px] font-medium text-ink group-hover:text-accent">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link
          className="group flex flex-col items-end gap-1 rounded-md border border-line bg-surface px-3.5 py-2.5 text-right hover:border-line-strong"
          href={next.path}
        >
          <span className="mono-label flex items-center gap-1">
            Next
            <ArrowRight size={11} strokeWidth={1.8} />
          </span>
          <span className="text-[13px] font-medium text-ink group-hover:text-accent">
            {next.title}
          </span>
        </Link>
      )}
    </div>
  );
}
