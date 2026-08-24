"use client";

// Provider sign-in buttons for the sign-in screen. Plain anchors: the OAuth
// dance starts server-side in /auth/oauth/[provider] so the PKCE cookie is
// minted alongside the provider redirect. The method is recorded at click
// time (the callback is a server redirect with no localStorage access).

import { useEffect, useState } from "react";

import { readLastAuthMethod, recordAuthMethod, type AuthMethod } from "@/lib/auth/last-used";

/** `dark` = the /signin page's onboard theme; `light` = the in-app login modal. */
type OAuthTone = "dark" | "light";

type OAuthButtonsProps = {
  next?: string;
  tone?: OAuthTone;
};

// Dark: brighter than the onboard-input/onboard-border tokens (3% / 10%
// white) — against the contribution-grid backdrop the controls need more
// presence, but the tokens are shared with other onboarding surfaces, so the
// bump is local to the auth controls. Light: the app's surface/line tokens.
const BUTTON_CLASS: Record<OAuthTone, string> = {
  dark: "relative flex w-full items-center justify-center gap-3 px-4 py-3 rounded-xl border border-white/20 bg-white/[0.08] text-sm font-semibold text-onboard-text hover:border-white/30 hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] transition-all",
  light:
    "relative flex w-full items-center justify-center gap-3 px-4 py-2.5 rounded-[var(--radius-md)] border border-line-strong bg-surface text-sm font-semibold text-ink hover:border-foreground/25 transition-colors"
};

export function OAuthButtons({ next = "/", tone = "dark" }: OAuthButtonsProps) {
  const query = `?next=${encodeURIComponent(next)}`;
  const [lastUsed, setLastUsed] = useState<AuthMethod | null>(null);

  // localStorage is read after mount so server and first client render agree.
  useEffect(() => {
    setLastUsed(readLastAuthMethod());
  }, []);

  return (
    <div className="space-y-3">
      <a
        href={`/auth/oauth/google${query}`}
        className={BUTTON_CLASS[tone]}
        onClick={() => recordAuthMethod("google")}
      >
        <GoogleIcon />
        Continue with Google
        {lastUsed === "google" && <LastUsedBadge tone={tone} />}
      </a>
      <a
        href={`/auth/oauth/github${query}`}
        className={BUTTON_CLASS[tone]}
        onClick={() => recordAuthMethod("github")}
      >
        <GitHubIcon />
        Continue with GitHub
        {lastUsed === "github" && <LastUsedBadge tone={tone} />}
      </a>
    </div>
  );
}

// The badge sits on a plain control by default and on the filled primary
// button when `inverted`; each combination keeps the pill legible there.
const BADGE_CLASS: Record<OAuthTone, { plain: string; inverted: string }> = {
  dark: {
    plain: "border-onboard-border text-onboard-muted",
    inverted: "border-onboard-bg/30 text-onboard-bg/70"
  },
  light: {
    plain: "border-line-strong text-muted",
    inverted: "border-white/30 text-white/70"
  }
};

/** Small pill marking the auth method this browser last signed in with. */
export function LastUsedBadge({
  inverted = false,
  tone = "dark"
}: {
  inverted?: boolean;
  tone?: OAuthTone;
}) {
  return (
    <span
      className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.1em] ${
        inverted ? BADGE_CLASS[tone].inverted : BADGE_CLASS[tone].plain
      }`}
    >
      Last used
    </span>
  );
}

const DIVIDER_CLASS: Record<OAuthTone, { line: string; label: string }> = {
  dark: { line: "bg-onboard-border", label: "text-onboard-muted" },
  light: { line: "bg-line", label: "text-muted" }
};

export function OAuthDivider({ tone = "dark" }: { tone?: OAuthTone }) {
  return (
    <div className="flex items-center gap-3 my-6">
      <div className={`h-px flex-1 ${DIVIDER_CLASS[tone].line}`} />
      <span
        className={`text-[11px] font-semibold uppercase tracking-[0.15em] font-mono ${DIVIDER_CLASS[tone].label}`}
      >
        or
      </span>
      <div className={`h-px flex-1 ${DIVIDER_CLASS[tone].line}`} />
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.63h6.46a5.53 5.53 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.28a7.21 7.21 0 0 1 0-4.56V6.61H1.27a12.01 12.01 0 0 0 0 10.78l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44A11.98 11.98 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
