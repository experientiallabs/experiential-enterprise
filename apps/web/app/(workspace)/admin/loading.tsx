import { Shimmer } from "@/components/ui/Shimmer";

/**
 * Body fallback for every admin section. It sits BELOW the admin layout on
 * purpose: switching sections through the tabs swaps only this area, so the
 * eyebrow and the tab strip never blink out. Shaped like a section header
 * over a table-ish card, which is what both current sections resolve to.
 */
export default function AdminSectionLoading() {
  return (
    <div aria-hidden className="flex min-h-full flex-col gap-5">
      <div>
        <Shimmer className="h-6 w-56" />
        <Shimmer className="mt-2 h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="flex items-center justify-between gap-3" key={index}>
            <Shimmer className="h-4 w-48" />
            <Shimmer className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
