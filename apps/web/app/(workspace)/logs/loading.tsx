import { Shimmer } from "@/components/ui/Shimmer";

/**
 * /telemetry fallback, mirroring TelemetryView's real geometry (the product owner,
 * 2026-07-31: the skeletons match the page they precede). No page title; the
 * page fills the viewport and never scrolls: the sticky filter bar, a four-tile
 * stat strip, then a two-column body — spend chart over the Usage breakdown on
 * the left, the request history on the right.
 */
export default function TelemetryLoading() {
  return (
    <div aria-hidden className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line py-2">
        <Shimmer className="h-8 w-64 rounded-lg" />
        <Shimmer className="h-[34px] w-32 rounded-md" />
        <Shimmer className="h-[34px] w-32 rounded-md" />
        <Shimmer className="h-[34px] w-28 rounded-md" />
        <Shimmer className="ml-auto h-4 w-28" />
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2.5 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="rounded-[var(--radius-md)] border border-line px-3 py-2" key={index}>
            <Shimmer className="h-3 w-16" />
            <Shimmer className="mt-2 h-5 w-20" />
            <Shimmer className="mt-1.5 h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="flex min-h-0 flex-col gap-3">
          <section className="shrink-0 rounded-[var(--radius-lg)] border border-line bg-surface p-3.5">
            <div className="flex items-center justify-between">
              <Shimmer className="h-3 w-24" />
              <Shimmer className="h-7 w-40 rounded-lg" />
            </div>
            <Shimmer className="mt-3 h-[180px] w-full rounded-md" />
          </section>
          <section className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
            <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
              <Shimmer className="h-4 w-16" />
              <Shimmer className="h-7 w-36 rounded-lg" />
            </div>
            <div className="flex flex-col gap-2 p-3.5">
              {Array.from({ length: 4 }, (_, index) => (
                <Shimmer className="h-[32px] rounded-md" key={index} />
              ))}
            </div>
          </section>
        </div>
        <section className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
          <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
            <Shimmer className="h-4 w-28" />
            <Shimmer className="ml-auto h-3 w-16" />
          </div>
          <div className="flex flex-col gap-2 p-3.5">
            {Array.from({ length: 9 }, (_, index) => (
              <Shimmer className="h-[36px] rounded-md" key={index} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
