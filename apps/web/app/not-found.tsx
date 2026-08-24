import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { ContributionGrid } from "@/components/onboarding/ContributionGrid";
import { buttonClassName } from "@/components/ui/Button";

/**
 * The app-wide 404, in house style (light surface, dark contribution grid,
 * one action) for genuinely unroutable paths.
 */
export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh flex-1 items-center justify-center overflow-hidden bg-background px-6 py-14">
      <ContributionGrid className="absolute inset-0 h-full w-full opacity-60" dark />
      <main className="relative z-10 w-full max-w-[480px] rounded-[var(--radius-lg)] border border-line bg-surface p-8 text-center shadow-[0_18px_50px_rgba(20,20,18,0.08)]">
        <p className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-2">
          404
        </p>
        <h1 className="m-0 mt-2 text-[24px] font-semibold tracking-tight text-ink">
          This page doesn&apos;t exist.
        </h1>
        <p className="m-0 mt-3 text-[13px] leading-relaxed text-muted">
          The link may be stale, or the page may have moved. Your workspace is still where you
          left it.
        </p>
        <div className="mt-6 flex justify-center">
          <Link className={buttonClassName("primary")} href="/">
            <ArrowRight aria-hidden size={15} strokeWidth={1.9} />
            Back to your workspace
          </Link>
        </div>
      </main>
    </div>
  );
}
