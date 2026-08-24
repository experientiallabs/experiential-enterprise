import { Shimmer } from "@/components/ui/Shimmer";

/**
 * /credits fallback, mirroring the page's real geometry (the product owner, ux-polish: every
 * async section on the money page gets a shaped skeleton, no bare spinner and no
 * layout shift). The page fetches the usage counters and the org's provider
 * connections server-side before it can render, so this stands in for that
 * first paint: the title block, the two top-line tabs, the combined spend card
 * (headline strip over the chart well), and the provider-balance squares — the
 * default tab. The nested cards on the Settings tab carry their own
 * in-component skeletons once mounted.
 */
export default function CreditsLoading() {
  return (
    <div aria-hidden className="flex h-full min-h-0 flex-col gap-5">
      {/* Title + description. */}
      <div className="flex flex-col gap-2">
        <Shimmer className="h-5 w-28" />
        <Shimmer className="h-3.5 w-[420px] max-w-full" />
      </div>

      {/* The two top-line tabs (Overview / Settings). */}
      <div className="flex gap-2">
        {Array.from({ length: 2 }, (_, index) => (
          <Shimmer className="h-[30px] w-24 rounded-lg" key={index} />
        ))}
      </div>

      {/* The combined spend card: headline strip over the chart well. */}
      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-[18px]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-5">
            <Shimmer className="h-4 w-28" />
            <Shimmer className="h-4 w-36" />
          </div>
          <Shimmer className="h-[30px] w-32 rounded-lg" />
        </div>
        <Shimmer className="h-[180px] w-full rounded-md" />
      </section>

      {/* The provider-balance squares: a compact four-up grid of eight tiles. */}
      <div className="flex flex-col gap-3">
        <Shimmer className="h-3.5 w-40" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <div
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
              key={index}
            >
              <div className="flex items-center justify-between gap-2">
                <Shimmer className="h-8 w-8 shrink-0 rounded-md" />
                <Shimmer className="h-3 w-14" />
              </div>
              <Shimmer className="h-3.5 w-20" />
              <Shimmer className="h-3 w-24 max-w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
