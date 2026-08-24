import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";

import { PostHogIdentity } from "@/components/telemetry/PostHogIdentity";
import { resolveActiveOrgForTelemetry } from "@/lib/active-org";
import { getAuthenticatedUser } from "@/lib/auth/server";

import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

// Every page carries its own metadata title through this template (the product owner, 2026-07-27);
// the default covers redirect-only routes that never render.
export const metadata: Metadata = {
  title: { default: "Experiential", template: "%s — Experiential" },
  description: "Build simulations from your traces, evaluate against them, and serve optimized endpoints."
};

type RootLayoutProps = {
  children: ReactNode;
};

export default async function RootLayout({ children }: RootLayoutProps) {
  // Request-scoped and cached, so this shares the verification the auth proxy
  // and nested layouts already pay; every route is auth-gated per request, so
  // the cookie read adds no meaningful dynamic-rendering cost.
  const user = await getAuthenticatedUser();
  // Enrich the PostHog identify with the workspace this session lands in.
  // The tolerant resolver shares the workspace layout's request-cached reads
  // and answers null (rather than redirecting) on signin/memberless renders.
  // Known cost: on authed NON-workspace routes (/orgs, /onboarding) this await
  // adds an org-list fetch to TTFB that those routes didn't previously pay.
  const activeOrg = user ? await resolveActiveOrgForTelemetry() : null;
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-dvh w-full flex-col bg-background">
        {children}
        <PostHogIdentity
          user={user}
          org={activeOrg ? { slug: activeOrg.slug, name: activeOrg.name } : null}
        />
      </body>
    </html>
  );
}
