import type { ReactNode } from "react";

type PolicyPageProps = {
  kicker: string;
  title: string;
  updated: string;
  children: ReactNode;
};

/** Shared typographic shell for the public policy pages (/privacy, /terms). */
export function PolicyPage({ kicker, title, updated, children }: PolicyPageProps) {
  return (
    <main className="min-h-dvh w-full bg-background">
      <article className="mx-auto flex w-full max-w-[720px] flex-col px-[clamp(1rem,4vw,2rem)] py-[clamp(2rem,8vh,4rem)]">
        <p className="m-0 mb-2 text-muted-2 text-[11px] font-semibold uppercase tracking-[0.08em]">
          {kicker}
        </p>
        <h1 className="m-0 text-[26px] font-semibold leading-tight text-ink">{title}</h1>
        <p className="mt-1 text-[12px] text-muted-2">Last updated {updated}</p>
        <div className="mt-6 flex flex-col gap-1 text-[14px] leading-relaxed text-muted [&_a]:text-ink [&_a]:underline [&_h2]:mb-1 [&_h2]:mt-5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:text-ink [&_p]:m-0">
          {children}
        </div>
      </article>
    </main>
  );
}
