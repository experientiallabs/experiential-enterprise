import { Shimmer } from "@/components/ui/Shimmer";

/**
 * /playground fallback, mirroring PlaygroundChat's geometry (the product owner,
 * 2026-07-31: the skeletons match the page they precede): the model picker
 * control bar, then the transcript-and-rail split — a tall chat well with its
 * composer strip on the left, the parameter rail's stacked cards on the right.
 * No title, per the round-2 no-title directive.
 */
export default function PlaygroundLoading() {
  return (
    <div aria-hidden className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
          <Shimmer className="h-[34px] w-64 rounded-md" />
        </div>
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <div className="flex min-h-[280px] flex-1 flex-col justify-end gap-2 rounded-lg border border-line bg-surface p-4">
              <Shimmer className="h-4 w-2/5" />
              <Shimmer className="h-4 w-3/5 self-end" />
              <Shimmer className="h-4 w-1/3" />
            </div>
            <Shimmer className="h-[46px] w-full rounded-md" />
          </div>
          <aside className="hidden flex-col gap-3 lg:flex">
            {[0, 1, 2].map((index) => (
              <div className="rounded-lg border border-line bg-surface p-4" key={index}>
                <Shimmer className="h-3 w-24" />
                <Shimmer className="mt-3 h-8 w-full" />
              </div>
            ))}
          </aside>
        </div>
      </div>
    </div>
  );
}
