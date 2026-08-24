import { Shimmer } from "@/components/ui/Shimmer";

/**
 * Section-body fallback for the settings routes. It must live at this level,
 * below settings/layout.tsx: the nearest boundary above the changing segment is
 * what suspends, and without this file that boundary was the group-level
 * loading.tsx, which sits above the layout and tore down the Settings header
 * and tab bar on every section click just to repaint them identical.
 */
export default function SettingsSectionLoading() {
  return (
    <div aria-hidden className="flex flex-col gap-[18px]">
      {[0, 1].map((section) => (
        <section className="rounded-lg border border-line bg-surface p-[18px]" key={section}>
          <Shimmer className="h-4 w-36" />
          <Shimmer className="mt-2 h-3 w-64" />
          <div className="mt-5 flex flex-col gap-3">
            <Shimmer className="h-9 w-full max-w-[420px]" />
            <Shimmer className="h-9 w-full max-w-[420px]" />
          </div>
        </section>
      ))}
    </div>
  );
}
