import type { ReactNode } from "react";

type AppShellProps = {
  children: ReactNode;
  sidebar: ReactNode;
};

export function AppShell({ children, sidebar }: AppShellProps) {
  return (
    <div
      className="grid h-dvh w-full overflow-hidden grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] bg-surface min-[901px]:grid-cols-[auto_minmax(0,1fr)] min-[901px]:grid-rows-1"
      data-layout="viewport-fill"
      data-testid="app-shell"
    >
      {sidebar}
      <main className="h-full min-w-0 overflow-y-auto bg-background px-[clamp(1rem,3vw,1.75rem)] py-[clamp(1.25rem,4vh,1.875rem)]">
        <div className="h-full w-full [container-type:inline-size]">{children}</div>
      </main>
    </div>
  );
}
