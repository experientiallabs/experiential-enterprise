import { Shimmer } from "@/components/ui/Shimmer";

/**
 * /insights fallback, mirroring the dashboard's geometry: the tab and window
 * controls, a four-up stat strip, two chart cards side by side, and the ranked
 * lists below.
 */
export default function InsightsLoading() {
  return (
    <div aria-hidden className="flex min-h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Shimmer className="h-[34px] w-56 rounded-lg" />
        <Shimmer className="h-[34px] w-64 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Shimmer className="h-14 rounded-[var(--radius-md)]" key={index} />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <section
            className="rounded-[var(--radius-lg)] border border-line bg-surface p-4"
            key={index}
          >
            <Shimmer className="h-4 w-36" />
            <Shimmer className="mt-3 h-[180px] w-full rounded-md" />
          </section>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <section
            className="rounded-[var(--radius-lg)] border border-line bg-surface p-4"
            key={index}
          >
            <Shimmer className="h-4 w-28" />
            <div className="mt-3 flex flex-col gap-2">
              {Array.from({ length: 4 }, (_, row) => (
                <Shimmer className="h-5 rounded-md" key={row} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
