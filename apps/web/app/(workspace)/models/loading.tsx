import { Shimmer } from "@/components/ui/Shimmer";

/**
 * Minimal, catalog-shaped fallback for a TRUE cold first load only.
 *
 * The old fallback returned null, which is exactly the white flash the product owner saw:
 * a loading.tsx REPLACES the segment during the RSC round trip (it never
 * "holds the previous view"), so null blanked the pane on every navigation.
 * Repeat navigations no longer suspend at all — next.config's
 * experimental.staleTimes keeps the /models payload in the client router cache,
 * so this skeleton renders only when there is genuinely nothing to show yet
 * (first visit, or a revisit after the 30s window). It mirrors the table's
 * real shape (toolbar, filter strip, header, rows) so the paint-over is calm.
 */
export default function ModelsLoading() {
  return (
    <div aria-hidden className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Shimmer className="h-[30px] w-64 rounded-md" />
        <Shimmer className="h-[30px] w-44 rounded-md" />
        <Shimmer className="ml-auto h-[30px] w-28 rounded-md" />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {Array.from({ length: 6 }, (_, index) => (
          <Shimmer className="h-[30px] w-24 rounded-md" key={index} />
        ))}
      </div>
      <div className="flex min-h-0 grow flex-col gap-px overflow-hidden rounded-lg border border-line bg-surface p-2">
        <Shimmer className="h-8 w-full" />
        {Array.from({ length: 12 }, (_, index) => (
          <Shimmer className="mt-1 h-9 w-full" key={index} />
        ))}
      </div>
    </div>
  );
}
