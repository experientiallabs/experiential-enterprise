import { Shimmer } from "@/components/ui/Shimmer";

export function AppSidebarSkeleton() {
  return (
    <aside
      aria-hidden
      className="sticky top-0 flex h-dvh min-h-dvh w-[clamp(13rem,20vw,15rem)] flex-col gap-[18px] overflow-hidden border-r border-line bg-background px-[clamp(0.75rem,1.5vw,1rem)] py-[clamp(1rem,3vh,1.25rem)] max-[900px]:h-auto max-[900px]:min-h-0 max-[900px]:w-full max-[900px]:flex-row max-[900px]:items-center max-[900px]:border-b max-[900px]:border-r-0 max-[900px]:px-[clamp(0.5rem,2vw,1rem)] max-[900px]:py-1.5"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_30px] gap-2 items-center max-[900px]:hidden">
        <Shimmer className="h-[30px]" />
        <Shimmer className="h-7 w-7" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-7 max-[900px]:hidden">
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 5 }, (_, index) => (
            <div className="grid h-[30px] grid-cols-[15px_minmax(0,1fr)] items-center gap-2 px-2" key={index}>
              <Shimmer className="h-[15px] w-[15px] rounded-[4px]" />
              <Shimmer className="h-3.5 w-full" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 mt-auto">
          <div className="rounded-[var(--radius-md)] border border-line bg-surface-subtle p-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Shimmer className="h-3 w-14" />
              <Shimmer className="h-3 w-9" />
            </div>
            <Shimmer className="h-1 w-full" />
          </div>
          {Array.from({ length: 3 }, (_, index) => (
            <div className="grid h-[30px] grid-cols-[15px_minmax(0,1fr)] items-center gap-2 px-2" key={index}>
              <Shimmer className="h-[15px] w-[15px] rounded-[4px]" />
              <Shimmer className="h-3.5 w-20" />
            </div>
          ))}
        </div>
      </div>
      {/* The top-bar shape the same rail takes on narrow viewports. */}
      <div className="hidden w-full items-center gap-3 max-[900px]:flex">
        <Shimmer className="h-6 w-24 shrink-0" />
        {Array.from({ length: 4 }, (_, index) => (
          <Shimmer className="h-4 w-16" key={index} />
        ))}
        <Shimmer className="ml-auto h-6 w-6 shrink-0 rounded-full" />
      </div>
    </aside>
  );
}
