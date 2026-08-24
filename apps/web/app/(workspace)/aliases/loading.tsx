import { Shimmer } from "@/components/ui/Shimmer";

/**
 * /aliases (Access control) fallback, mirroring the page's real geometry
 * (skeletons match the page they precede): the page header, the named-aliases
 * card with its header row and table, then the identity tier — budget cards
 * over the identity list/detail grid. Locks to the viewport at lg exactly
 * like the live page so the snap from fallback to content doesn't reflow.
 */
export default function AliasesLoading() {
  return (
    <div aria-hidden className="flex min-h-full flex-col gap-5 lg:h-full lg:min-h-0">
      <div className="shrink-0">
        <Shimmer className="h-6 w-44" />
        <Shimmer className="mt-2 h-4 w-full max-w-[520px]" />
      </div>
      <section className="shrink-0 rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-[18px] py-3.5">
          <div className="min-w-[240px] max-w-[520px] flex-1">
            <Shimmer className="h-3 w-28" />
            <Shimmer className="mt-2 h-4 w-full max-w-96" />
          </div>
          <div className="flex items-end gap-2">
            <Shimmer className="h-[34px] w-36 rounded-md" />
            <Shimmer className="h-[34px] w-44 rounded-md" />
            <Shimmer className="h-[34px] w-20 rounded-md" />
          </div>
        </div>
        <div className="flex flex-col gap-2.5 border-t border-line px-4 py-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Shimmer className="h-4 w-full" key={index} />
          ))}
        </div>
      </section>
      <div className="flex min-h-0 flex-col gap-4 lg:flex-1">
        <div className="shrink-0">
          <Shimmer className="h-4 w-40" />
          <Shimmer className="mt-2 h-4 w-full max-w-[520px]" />
        </div>
        <div className="grid shrink-0 grid-cols-1 gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }, (_, index) => (
            <div className="rounded-lg border border-line bg-surface p-[18px]" key={index}>
              <Shimmer className="h-3 w-44" />
              <Shimmer className="mt-3 h-4 w-full max-w-72" />
            </div>
          ))}
        </div>
        <div className="grid min-h-0 grid-cols-1 gap-4 lg:min-h-[16rem] lg:flex-1 lg:grid-cols-[300px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
          <section className="flex min-h-0 flex-col rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-[18px] py-3">
              <Shimmer className="h-3 w-20" />
            </div>
            <div className="flex flex-col gap-2.5 p-[18px]">
              {Array.from({ length: 4 }, (_, index) => (
                <Shimmer className="h-4 w-full" key={index} />
              ))}
            </div>
          </section>
          <section className="min-h-0 rounded-lg border border-line bg-surface p-[18px]">
            <Shimmer className="h-5 w-48" />
            <Shimmer className="mt-4 h-3 w-24" />
            <Shimmer className="mt-2 h-4 w-full max-w-96" />
            <Shimmer className="mt-4 h-3 w-32" />
            <Shimmer className="mt-2 h-4 w-full max-w-80" />
          </section>
        </div>
      </div>
    </div>
  );
}
