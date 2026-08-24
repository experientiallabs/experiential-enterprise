import { Shimmer } from "@/components/ui/Shimmer";

/**
 * Model detail fallback, mirroring the detail page's geometry (the product owner,
 * 2026-07-31: the skeletons match the page they precede): back link, name row
 * with the action pair, the stat-tile strip, the providers table, then the
 * two-column keys/snippet band. Without this file the models table skeleton
 * would show here, which is the wrong shape for a detail page.
 */
export default function ModelDetailLoading() {
  return (
    <div aria-hidden className="flex flex-col gap-5">
      <Shimmer className="h-4 w-24" />
      <div className="flex min-h-[32px] flex-wrap items-center justify-between gap-3">
        <Shimmer className="h-6 w-48" />
        <div className="flex items-center gap-2">
          <Shimmer className="h-[30px] w-24 rounded-md" />
          <Shimmer className="h-[30px] w-36 rounded-md" />
        </div>
      </div>
      <div className="flex flex-wrap items-stretch gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div
            className="flex min-w-[130px] flex-col justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-3"
            key={index}
          >
            <Shimmer className="h-3 w-16" />
            <Shimmer className="h-5 w-20" />
          </div>
        ))}
      </div>
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-2.5">
          <Shimmer className="h-3 w-full max-w-xl" />
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <div
            className="flex min-h-[38px] items-center gap-6 border-b border-line px-4 last:border-b-0"
            key={index}
          >
            <Shimmer className="h-3.5 w-24" />
            <Shimmer className="h-3.5 grow" />
            <Shimmer className="h-3.5 w-16" />
          </div>
        ))}
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((index) => (
          <section
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]"
            key={index}
          >
            <Shimmer className="h-4 w-32" />
            <Shimmer className="h-[140px] w-full rounded-md" />
          </section>
        ))}
      </div>
    </div>
  );
}
