"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "@/components/brand/BrandMark";
import { CodeLanguageProvider } from "@/components/docs/code-language";
import { DocsSearch } from "@/components/docs/DocsSearch";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { DocsThemeToggle } from "@/components/docs/DocsThemeToggle";
import { OnThisPage } from "@/components/docs/OnThisPage";
import { PrevNext } from "@/components/docs/PrevNext";
import { signinPath } from "@/lib/routes";

// The docs section's own chrome — deliberately NOT the workspace AppShell:
// docs are public reading surfaces, so they get a Mintlify-style layout
// (header with search and theme toggle, grouped left nav, article column,
// on-this-page rail) instead of the app sidebar. Everything is public; the
// header always offers the way in ("Sign in", or back to the app when a
// session exists).

export function DocsShell({
  signedIn,
  children
}: {
  signedIn: boolean;
  children: ReactNode;
}) {
  return (
    <CodeLanguageProvider>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-40 border-b border-line bg-background/90 backdrop-blur">
          <div className="mx-auto flex h-13 w-full max-w-[1400px] items-center gap-3 px-[clamp(12px,3vw,24px)] py-2.5">
            <Link className="flex items-center gap-2" href="/">
              <BrandMark className="h-[18px] w-[18px] text-ink" />
              <span className="text-[13.5px] font-semibold tracking-tight text-ink">
                Experiential
              </span>
            </Link>
            <span className="mono-label mt-px">Docs</span>
            <div className="ml-auto flex items-center gap-2">
              <DocsSearch />
              <DocsThemeToggle />
              <span aria-hidden className="h-4 w-px bg-line" />
              {signedIn ? (
                <Link className="text-[12.5px] font-medium text-muted hover:text-ink" href="/">
                  Open app
                </Link>
              ) : (
                // Interim per design-system.md's gating contract: swap this
                // link for useLoginModal().open once the app-shell workstream
                // ships the hook (it does not exist on main yet).
                <Link
                  className="text-[12.5px] font-medium text-muted hover:text-ink"
                  href={signinPath()}
                >
                  Sign in
                </Link>
              )}
            </div>
          </div>
        </header>
        <DocsSidebar horizontal />
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 items-stretch">
          <aside className="sticky top-13 hidden max-h-[calc(100dvh-52px)] w-[220px] shrink-0 overflow-y-auto border-r border-line py-6 pl-[clamp(12px,3vw,24px)] pr-3 lg:block">
            <DocsSidebar />
          </aside>
          <main className="min-w-0 flex-1">
            <article
              className="mx-auto w-full max-w-[760px] px-[clamp(16px,4vw,40px)] py-[clamp(24px,5dvh,48px)]"
              id="docs-article"
            >
              {children}
              <PrevNext />
            </article>
          </main>
          <aside className="sticky top-13 hidden max-h-[calc(100dvh-52px)] w-[210px] shrink-0 overflow-y-auto py-[clamp(24px,5dvh,48px)] pr-[clamp(12px,3vw,24px)] xl:block">
            <OnThisPage />
          </aside>
        </div>
      </div>
    </CodeLanguageProvider>
  );
}
