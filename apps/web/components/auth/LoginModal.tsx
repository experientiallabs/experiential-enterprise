"use client";

import { useEffect, useId, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { AuthForm } from "@/components/auth/AuthForm";
import { WelcomeCelebration } from "@/components/auth/WelcomeCelebration";
import { WELCOME_PARAM, type LoginModalStep } from "@/components/auth/login-modal-context";
import { fetchWelcomeData, type WelcomeData } from "@/components/auth/welcome-data";

// The welcome reveal is a ONE-TIME, first-key-mint event. Right after signup
// /api/welcome can 404 (no_org) or read a null summary until the new membership
// is visible to the RLS session, so the reveal polls on a short backoff. The
// DURABLE first-time signal is a freshly MINTED secret: fetchWelcomeData mints
// the org's first key only when none exists, so a non-null mintedSecret means
// "no key existed yet" — the initial reveal. Once the org holds a key, every
// later read returns keyPrefix with mintedSecret === null and the reveal never
// shows again, on any subsequent login, OAuth return (?welcome=1), or refresh.
const WELCOME_RETRY_INTERVAL_MS = 700;
// Past this window the poll slows to a low cadence (the mint or the membership
// read is taking unusually long). The reveal still never terminally closes a
// first-time signup on a slow read: it waits for the mint so the ONLY thing it
// ever shows is a real minted key, which is also the durable signal that stops
// it from ever showing again.
const WELCOME_RETRY_BUDGET_MS = 8000;
const WELCOME_SLOW_RETRY_INTERVAL_MS = 3000;

type LoginModalProps = {
  step: LoginModalStep;
  /**
   * An in-modal auth succeeded; the provider decides the next step from
   * `created` — only a brand-new account advances to the welcome/success step,
   * a returning login just closes so no celebration pops on ordinary sign-ins.
   */
  onAuthSuccess: (result: { created: boolean }) => void;
  onClose: () => void;
  /** Public web origin for the paste-able onboarding prompts. */
  webBaseUrl: string;
  /** Public API base URL (`${api}/v1`) for the onboarding prompts. */
  apiBaseUrl: string;
  /**
   * Fired once the first-key reveal loads, so the provider can re-render the
   * server tree and the sidebar credit meter reads the welcome grant.
   */
  onWelcomeLoaded: () => void;
};

/**
 * The in-place login dialog (docs/design-system.md "Gating patterns"),
 * rendered by LoginModalProvider. The form step re-hosts the /signin form on
 * the app's light tokens. The success step is the one-time first-key reveal:
 * it renders nothing until it confirms a key was actually minted (no key
 * existed yet), so it can never re-appear once the org has a key. Invite flows
 * stay on /signin.
 */
export function LoginModal({
  step,
  onAuthSuccess,
  onClose,
  webBaseUrl,
  apiBaseUrl,
  onWelcomeLoaded
}: LoginModalProps) {
  const titleId = useId();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Escape closes the form step; the success reveal owns its own Escape handler
  // so it is only active once the reveal is actually on screen.
  useEffect(() => {
    if (step !== "form") {
      return;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, step]);

  if (step === "closed") {
    return null;
  }

  if (step === "success") {
    return (
      <WelcomeReveal
        onClose={onClose}
        webBaseUrl={webBaseUrl}
        apiBaseUrl={apiBaseUrl}
        onWelcomeLoaded={onWelcomeLoaded}
      />
    );
  }

  // OAuth leaves the page (provider redirect), so the return target is this
  // page plus the welcome marker: back here, modal open on the success step.
  const returnParams = new URLSearchParams(searchParams);
  returnParams.set(WELCOME_PARAM, "1");
  const oauthNext = `${pathname}?${returnParams.toString()}`;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-6"
      data-testid="login-modal"
      onClick={onClose}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative w-full max-w-[400px] overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface p-7 shadow-[0_18px_50px_rgba(20,20,18,0.14)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <h2 className="m-0 mb-6 text-[19px] font-semibold tracking-tight text-ink" id={titleId}>
          Sign in
        </h2>
        <AuthForm
          inviteToken={null}
          prefillEmail={null}
          tone="light"
          oauthNext={oauthNext}
          onSuccess={onAuthSuccess}
        />
      </section>
    </div>
  );
}

/**
 * The one-time first-key reveal. It polls the welcome read on a short backoff
 * and renders NOTHING until a freshly minted secret confirms this is the org's
 * first key (the durable first-time signal, and the ONLY thing it ever shows).
 * If the read resolves to an EXISTING key it closes without ever showing, so the
 * reveal cannot re-appear on a later login, an OAuth return, or a refresh. If
 * the read or mint is slow it never closes and never shows a keyless modal: it
 * keeps polling (fast, then a slow cadence) until the mint lands, because a
 * later ordinary login is created:false and would not re-enter this step, so a
 * terminal close or a keyless reveal that a marker could replay would either
 * lose the celebration or repeat it. Once shown it stays until the user closes
 * it (a link, Escape, or a backdrop click).
 */
function WelcomeReveal({
  onClose,
  webBaseUrl,
  apiBaseUrl,
  onWelcomeLoaded
}: {
  onClose: () => void;
  webBaseUrl: string;
  apiBaseUrl: string;
  onWelcomeLoaded: () => void;
}) {
  const [data, setData] = useState<WelcomeData | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    async function attempt(): Promise<void> {
      const result = await fetchWelcomeData();
      if (cancelled) {
        return;
      }
      if (result !== null) {
        if (result.mintedSecret !== null) {
          // A key was just minted: no key existed, so this is the first-time
          // reveal. Show it, and refresh the server tree so the sidebar meter
          // reflects the welcome grant.
          setData(result);
          setRevealed(true);
          onWelcomeLoaded();
          return;
        }
        if (result.keyPrefix !== null) {
          // The org already holds a key: not a first-time reveal, so it can
          // never show again. This is the durable, permanent close.
          onClose();
          return;
        }
        if (!result.canManageKeys) {
          // A session that cannot mint the org's first key (a non-admin member)
          // has no first-key reveal to wait for: close instead of polling
          // forever for a mint that will never happen.
          onClose();
          return;
        }
        // Keyless but mintable: the /api/keys mint failed transiently, so keep
        // polling. A failed mint creates no key, and the first successful mint
        // reveals and stops, so this never spams keys.
      }
      // Null summary or keyless: keep polling, fast until the budget then a slow
      // cadence, until the mint lands (reveal) or a key is found (close). Never
      // terminally close a first-time signup on a slow read and never show a
      // keyless modal a marker could replay; the poll stops on unmount.
      const interval =
        Date.now() - startedAt >= WELCOME_RETRY_BUDGET_MS
          ? WELCOME_SLOW_RETRY_INTERVAL_MS
          : WELCOME_RETRY_INTERVAL_MS;
      timer = window.setTimeout(() => void attempt(), interval);
    }

    void attempt();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [onClose, onWelcomeLoaded]);

  // Render nothing until a real minted key confirms this is the first-time
  // reveal: no overlay flashes on a returning login or an OAuth return that
  // resolves to an existing key, and no keyless modal a marker could replay.
  if (!revealed || data === null || data.mintedSecret === null) {
    return null;
  }

  const grantedUsd =
    data.grantedUsd !== null && data.grantedUsd !== undefined ? data.grantedUsd : null;

  return (
    <WelcomeCelebration
      grantedUsd={grantedUsd}
      apiKey={data.mintedSecret}
      showApiKey
      webBaseUrl={webBaseUrl}
      apiBaseUrl={apiBaseUrl}
      creditCaption="in free credits to start"
      onClose={onClose}
    />
  );
}
