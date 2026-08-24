import { SkeletonChip } from "@/components/ui/Chip";
import { Shimmer } from "@/components/ui/Shimmer";

/**
 * The group's LAST-RESORT fallback: a neutral header row and card grid.
 * Every primary surface now carries its own page-shaped fallback (models,
 * simulations, playground, telemetry, settings, the model detail and
 * walkthrough - the product owner, 2026-07-31: skeletons match the page they precede),
 * so this renders only for segments without one (docs, admin).
 */
export default function OrgLoading() {
  return (
    <div aria-hidden className="flex min-h-full flex-col gap-5">
      <div className="flex min-h-[32px] items-center justify-between gap-[18px]">
        <div className="min-w-0">
          <Shimmer className="h-6 w-40" />
          <Shimmer className="mt-2 h-4 w-64" />
        </div>
        <SkeletonChip className="w-24" />
      </div>
      <section className="grid shrink-0 grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[18px]">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="rounded-lg border border-line bg-surface p-[18px]" key={index}>
            <div className="flex min-h-[132px] flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <Shimmer className="h-4 w-28" />
                  <SkeletonChip className="w-16" />
                </div>
                <Shimmer className="mt-2.5 h-3 w-full max-w-44" />
                <Shimmer className="mt-1.5 h-3 w-full max-w-36" />
              </div>
              <div className="flex items-center gap-3">
                <Shimmer className="h-3 w-14" />
                <Shimmer className="h-3 w-14" />
                <Shimmer className="h-3 w-14" />
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
